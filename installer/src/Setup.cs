// Repodeck Setup: install, repair and uninstall for the current user. No administrator rights.
// Built with the C# compiler that ships with Windows (.NET Framework 4.x), so it runs on a clean machine.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Net;
using System.Reflection;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

class Tool
{
    public string Name, Exe, Args, Pattern, WingetId;
    public Version Min;
    public Version Found;       // null = missing
    public bool Ok { get { return Found != null && Found >= Min; } }
}

class SetupForm : Form
{
    const string AppName = "Repodeck";
    const string RegKey = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\Repodeck";

    readonly string installDir;
    // Same override the app itself honours, so tests never touch the real settings or a running copy.
    readonly string dataDir = Environment.GetEnvironmentVariable("REPODECK_DATA") ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Repodeck");
    readonly List<Tool> tools = new List<Tool>();
    readonly bool silent;
    readonly string silentAction;
    public int ExitCode;
    public static string DirOverride;   // /dir "<folder>": install somewhere else
    public static bool Portable;        // /portable: no shortcuts, no Apps entry
    public static string Snapshot;      // /snapshot <png>: save a picture of the window and exit (layout checks)

    Label title, subtitle, status, toolsTitle, hint;
    Panel toolsPanel;
    CheckBox chkDesktop, chkTools, chkData, chkLaunch;
    Button btnPrimary, btnRepair, btnUninstall, btnClose;
    TextBox log;
    ProgressBar progress;
    bool busy;
    string installedVersion;

    public SetupForm(string action, bool silent)
    {
        this.silent = silent;
        this.silentAction = action;
        installDir = DirOverride ?? ExistingInstallDir() ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "Repodeck");
        tools.Add(new Tool { Name = "Git", Exe = "git", Args = "--version", Pattern = @"(\d+\.\d+\.\d+)", Min = new Version(2, 30, 0), WingetId = "Git.Git" });
        tools.Add(new Tool { Name = "GitHub CLI", Exe = "gh", Args = "--version", Pattern = @"(\d+\.\d+\.\d+)", Min = new Version(2, 40, 0), WingetId = "GitHub.cli" });
        tools.Add(new Tool { Name = "Node.js", Exe = "node", Args = "--version", Pattern = @"v(\d+\.\d+\.\d+)", Min = new Version(20, 0, 0), WingetId = "OpenJS.NodeJS.LTS" });
        BuildUi();
        Shown += delegate
        {
            RefreshState();
            if (Snapshot != null) { if (action == "uninstall" && IsInstalled()) ShowUninstallChoice(); using (var bmp = new Bitmap(Width, Height)) { DrawToBitmap(bmp, new Rectangle(0, 0, Width, Height)); bmp.Save(Snapshot, System.Drawing.Imaging.ImageFormat.Png); } Close(); return; }
            if (silent) Run(silentAction);
            else if (action == "uninstall" && IsInstalled()) ShowUninstallChoice();
        };
    }

    // ------------------------------------------------------------------ UI
    void BuildUi()
    {
        Text = AppName + " Setup";
        Font = new Font("Segoe UI", 9f);
        AutoScaleMode = AutoScaleMode.Dpi;
        ClientSize = new Size(600, 520);
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        StartPosition = FormStartPosition.CenterScreen;
        BackColor = Color.White;
        try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }

        var header = new Panel { Dock = DockStyle.Top, Height = 84, BackColor = Color.FromArgb(20, 56, 47) };
        title = new Label { Text = AppName, ForeColor = Color.White, Font = new Font("Segoe UI Semibold", 17f), AutoSize = true, Location = new Point(22, 14) };
        subtitle = new Label { Text = "Version " + BuildInfo.Version, ForeColor = Color.FromArgb(150, 214, 196), AutoSize = true, Location = new Point(24, 50) };
        header.Controls.Add(title); header.Controls.Add(subtitle);
        Controls.Add(header);

        status = new Label { Location = new Point(22, 100), Size = new Size(556, 38), Text = "", AutoEllipsis = true };
        Controls.Add(status);

        toolsTitle = new Label { Text = "Required tools", Font = new Font("Segoe UI Semibold", 9f), Location = new Point(22, 142), AutoSize = true };
        Controls.Add(toolsTitle);
        toolsPanel = new Panel { Location = new Point(22, 164), Size = new Size(556, 72) };
        Controls.Add(toolsPanel);

        chkTools = new CheckBox { Text = "Download and install missing tools with winget (official source)", Location = new Point(22, 242), AutoSize = true, Checked = true };
        chkDesktop = new CheckBox { Text = "Create a desktop shortcut", Location = new Point(22, 266), AutoSize = true, Checked = false };
        chkLaunch = new CheckBox { Text = "Start Repodeck when finished", Location = new Point(22, 290), AutoSize = true, Checked = false, Visible = false }; // the finish screen has an Open button instead
        chkData = new CheckBox { Text = "Also delete my settings, logs and safety copies of discarded changes", Location = new Point(22, 266), AutoSize = true, Visible = false };
        Controls.Add(chkTools); Controls.Add(chkDesktop); Controls.Add(chkLaunch); Controls.Add(chkData);

        log = new TextBox { Location = new Point(22, 320), Size = new Size(556, 118), Multiline = true, ReadOnly = true, ScrollBars = ScrollBars.Vertical, BackColor = Color.FromArgb(247, 247, 245), BorderStyle = BorderStyle.FixedSingle, Font = new Font("Consolas", 8.5f) };
        log.Visible = false;
        Controls.Add(log);
        hint = new Label { Location = new Point(22, 330), Size = new Size(556, 100), ForeColor = Color.DimGray, Text = "Setup copies Repodeck into your user profile and adds a Start menu entry.\nNothing is installed for other users and no administrator rights are needed.\n\nYou sign in to GitHub later, inside the app." };
        Controls.Add(hint);
        progress = new ProgressBar { Location = new Point(22, 444), Size = new Size(556, 6), Style = ProgressBarStyle.Marquee, MarqueeAnimationSpeed = 25, Visible = false };
        Controls.Add(progress);

        btnPrimary = MakeButton("Install", 0, true);
        btnRepair = MakeButton("Repair", 0, true);
        btnUninstall = MakeButton("Uninstall", 0, false);
        btnClose = MakeButton("Close", 0, false);
        btnPrimary.Click += delegate { Run("install"); };
        btnRepair.Click += delegate { Run("repair"); };
        btnUninstall.Click += delegate { ShowUninstallChoice(); };
        btnClose.Click += delegate { Close(); };
        FormClosing += delegate(object s, FormClosingEventArgs e) { if (busy) e.Cancel = true; };
    }

    Button MakeButton(string text, int x, bool primary)
    {
        var b = new Button { Text = text, Size = new Size(110, 32), Location = new Point(x, 472), FlatStyle = FlatStyle.System };
        if (primary) b.Font = new Font("Segoe UI Semibold", 9f);
        Controls.Add(b);
        return b;
    }

    void LayoutButtons(params Button[] visible)
    {
        foreach (var b in new[] { btnPrimary, btnRepair, btnUninstall, btnClose }) b.Visible = false;
        int x = 578;
        for (int i = visible.Length - 1; i >= 0; i--)
        {
            x -= visible[i].Width;
            visible[i].Location = new Point(x, 472);
            visible[i].Visible = true;
            x -= 8;
        }
        AcceptButton = visible.Length > 0 ? visible[0] : null;
    }

    bool uninstallMode;
    void ShowUninstallChoice()
    {
        uninstallMode = true;
        status.Text = "Remove Repodeck " + installedVersion + " from this computer?\nYour repositories are not touched. Git, GitHub CLI and Node.js stay installed.";
        chkTools.Visible = chkDesktop.Visible = chkLaunch.Visible = false;
        chkData.Visible = true;
        toolsTitle.Visible = toolsPanel.Visible = false;
        chkData.Location = new Point(22, 150);
        hint.Text = "Removes the program files, the shortcuts and the entry in Installed apps.\nYour settings are kept unless you tick the box above.";
        hint.Location = new Point(22, 190);
        btnPrimary.Text = "Uninstall";
        btnClose.Text = "Cancel";
        LayoutButtons(btnUninstallConfirm(), btnClose);
    }
    Button confirmBtn, openBtn;
    Button btnUninstallConfirm()
    {
        if (confirmBtn == null)
        {
            confirmBtn = MakeButton("Uninstall", 0, true);
            confirmBtn.Click += delegate { Run("uninstall"); };
        }
        return confirmBtn;
    }

    void RefreshState()
    {
        installedVersion = InstalledVersion();
        bool installed = IsInstalled();
        RefreshPath();
        toolsPanel.Controls.Clear();
        int y = 0;
        bool anyMissing = false;
        foreach (var t in tools)
        {
            t.Found = Probe(t);
            if (!t.Ok) anyMissing = true;
            var dot = new Label { Text = t.Ok ? "✔" : "✖", ForeColor = t.Ok ? Color.FromArgb(31, 122, 67) : Color.FromArgb(180, 35, 44), Location = new Point(2, y), Size = new Size(18, 20) };
            var name = new Label { Text = t.Name, Location = new Point(24, y), Size = new Size(120, 20) };
            var val = new Label { Text = t.Found == null ? "not installed" : (t.Ok ? "version " + t.Found : "version " + t.Found + " is too old (needs " + t.Min + ")"), ForeColor = t.Ok ? Color.DimGray : Color.FromArgb(180, 35, 44), Location = new Point(150, y), Size = new Size(400, 20) };
            toolsPanel.Controls.Add(dot); toolsPanel.Controls.Add(name); toolsPanel.Controls.Add(val);
            y += 23;
        }
        chkTools.Visible = anyMissing && !uninstallMode;
        chkTools.Checked = anyMissing;
        int oy = anyMissing ? 266 : 242;
        chkDesktop.Location = new Point(22, oy);
        chkDesktop.Visible = !Portable && !uninstallMode;
        if (uninstallMode) return;
        if (installed)
        {
            bool same = installedVersion == BuildInfo.Version;
            status.Text = "Repodeck " + installedVersion + " is installed in\n" + installDir;
            btnRepair.Text = same ? "Repair" : "Update to " + BuildInfo.Version;
            LayoutButtons(btnRepair, btnUninstall, btnClose);
        }
        else
        {
            status.Text = "Installs for you only, in\n" + installDir + "   (no administrator rights needed)";
            LayoutButtons(btnPrimary, btnClose);
        }
    }

    void Log(string line)
    {
        if (InvokeRequired) { BeginInvoke(new Action<string>(Log), line); return; }
        log.AppendText(line + Environment.NewLine);
        try { Directory.CreateDirectory(dataDir); File.AppendAllText(Path.Combine(dataDir, "install.log"), DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + "  " + line + Environment.NewLine); } catch { }
    }

    // ------------------------------------------------------------------ run
    void Run(string action)
    {
        if (busy) return;
        busy = true;
        hint.Visible = false; log.Visible = true;
        progress.Visible = true;
        foreach (var b in new[] { btnPrimary, btnRepair, btnUninstall, btnClose }) b.Enabled = false;
        if (confirmBtn != null) confirmBtn.Enabled = false;
        bool wantTools = chkTools.Checked, wantDesktop = chkDesktop.Checked, wantLaunch = chkLaunch.Checked && !silent, wipeData = chkData.Checked;
        var worker = new Thread(delegate()
        {
            string error = null;
            bool toolsMissing = false;
            try
            {
                if (action == "uninstall") Uninstall(wipeData);
                else toolsMissing = !Install(wantTools, wantDesktop, action == "repair");
            }
            catch (Exception e) { error = e.Message; Log("FAILED: " + e); }
            BeginInvoke(new Action(delegate { Finished(action, error, toolsMissing, wantLaunch); }));
        });
        worker.IsBackground = true;
        worker.SetApartmentState(ApartmentState.STA);
        worker.Start();
    }

    void Finished(string action, string error, bool toolsMissing, bool launch)
    {
        busy = false;
        progress.Visible = false;
        foreach (var b in new[] { btnPrimary, btnRepair, btnUninstall, btnClose }) b.Enabled = true;
        ExitCode = error != null ? 1 : 0;
        if (silent) { Close(); return; }
        btnClose.Text = "Close";
        chkData.Visible = false;
        if (error != null)
        {
            status.Text = "Something went wrong: " + error + "\nDetails are below and in " + Path.Combine(dataDir, "install.log");
            LayoutButtons(btnClose);
            return;
        }
        if (action == "uninstall")
        {
            status.Text = "Repodeck was removed.\nGit, GitHub CLI and Node.js are still installed.";
            chkTools.Visible = chkDesktop.Visible = chkLaunch.Visible = false;
            LayoutButtons(btnClose);
            return;
        }
        uninstallMode = false;
        RefreshState();
        // Make the result unmistakable, and never start the app unless the user asks.
        title.Text = toolsMissing ? "Installed, with warnings" : (action == "repair" ? "Repair complete" : "Installation complete");
        subtitle.Text = toolsMissing ? "Some required tools are still missing" : "Repodeck " + BuildInfo.Version + " is ready to use";
        status.Font = new Font("Segoe UI Semibold", 10f);
        status.ForeColor = toolsMissing ? Color.FromArgb(154, 97, 0) : Color.FromArgb(31, 122, 67);
        status.Text = toolsMissing ? "Repodeck is installed, but it cannot run until the tools marked below are installed.\nInstall them, then run Setup again and choose Repair." : "✔  Repodeck is installed. You will find it in the Start menu.\nNothing was opened: use the button below when you want to start it.";
        chkTools.Visible = chkDesktop.Visible = false;
        if (openBtn == null) { openBtn = MakeButton("Open Repodeck", 0, true); openBtn.Size = new Size(140, 32); openBtn.Click += delegate { StartApp(); Close(); }; }
        if (toolsMissing) LayoutButtons(btnClose); else LayoutButtons(openBtn, btnClose);
    }

    void StartApp()
    {
        try { Process.Start(new ProcessStartInfo(Path.Combine(installDir, "Repodeck.exe")) { WorkingDirectory = installDir, UseShellExecute = false }); } catch (Exception e) { Log("Could not start Repodeck: " + e.Message); }
    }

    // ------------------------------------------------------------------ install / repair
    /// <returns>true when every required tool is present afterwards</returns>
    bool Install(bool installTools, bool desktop, bool repair)
    {
        Log((repair ? "Repairing" : "Installing") + " Repodeck " + BuildInfo.Version + " in " + installDir);
        StopRunningApp();
        RemoveLegacy();

        bool allOk = true;
        foreach (var t in tools)
        {
            if (t.Ok) continue;
            if (!installTools) { Log(t.Name + " is missing and was not installed (option unchecked)."); allOk = false; continue; }
            if (!InstallTool(t)) allOk = false;
        }

        Log("Copying files...");
        Directory.CreateDirectory(installDir);
        foreach (var d in new[] { "server", "ui", "installer" }) DeleteDir(Path.Combine(installDir, d)); // "installer" = leftovers of the old script installer
        using (var s = Assembly.GetExecutingAssembly().GetManifestResourceStream("payload.zip"))
        {
            if (s == null) throw new Exception("This Setup file is incomplete (no payload). Download it again.");
            using (var zip = new ZipArchive(s, ZipArchiveMode.Read))
            {
                foreach (var entry in zip.Entries)
                {
                    string rel = entry.FullName.Replace('/', Path.DirectorySeparatorChar);
                    string dest = Path.GetFullPath(Path.Combine(installDir, rel));
                    if (!dest.StartsWith(Path.GetFullPath(installDir) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)) continue; // never write outside the install folder
                    if (entry.FullName.EndsWith("/")) { Directory.CreateDirectory(dest); continue; }
                    Directory.CreateDirectory(Path.GetDirectoryName(dest));
                    entry.ExtractToFile(dest, true);
                }
            }
        }
        string self = Application.ExecutablePath;
        string setupCopy = Path.Combine(installDir, "Setup.exe");
        if (!string.Equals(Path.GetFullPath(self), Path.GetFullPath(setupCopy), StringComparison.OrdinalIgnoreCase)) File.Copy(self, setupCopy, true);

        string exe = Path.Combine(installDir, "Repodeck.exe");
        if (Portable) { Log("Portable install: no shortcuts and no Apps entry. Start it with " + exe); return allOk; }
        Log("Creating shortcuts...");
        CreateShortcut(Path.Combine(StartMenuDir(), "Repodeck.lnk"), exe);
        string desk = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), "Repodeck.lnk");
        if (desktop) CreateShortcut(desk, exe);

        using (var k = Registry.CurrentUser.CreateSubKey(RegKey))
        {
            k.SetValue("DisplayName", AppName);
            k.SetValue("DisplayVersion", BuildInfo.Version);
            k.SetValue("Publisher", AppName);
            k.SetValue("InstallLocation", installDir);
            k.SetValue("DisplayIcon", exe + ",0");
            k.SetValue("UninstallString", "\"" + setupCopy + "\" /uninstall");
            k.SetValue("ModifyPath", "\"" + setupCopy + "\"");
            k.SetValue("QuietUninstallString", "\"" + setupCopy + "\" /uninstall /quiet");
            k.SetValue("NoRepair", 1, RegistryValueKind.DWord);
            k.SetValue("EstimatedSize", (int)(DirSize(installDir) / 1024), RegistryValueKind.DWord);
        }
        // Notifications appear under the app's own name and icon instead of "Windows PowerShell".
        using (var k = Registry.CurrentUser.CreateSubKey(@"Software\Classes\AppUserModelId\Repodeck.App"))
        {
            k.SetValue("DisplayName", AppName);
            k.SetValue("IconUri", Path.Combine(installDir, "ui", "icon-256.png"));
        }
        Log(allOk ? "Done." : "Done, but some required tools are missing. Repodeck will tell you which when it starts.");
        return allOk;
    }

    bool InstallTool(Tool t)
    {
        string winget = Which("winget");
        if (winget == null)
        {
            Log(t.Name + ": cannot install automatically because winget (App Installer) is not available.");
            Log("  Install \"App Installer\" from the Microsoft Store, then run Setup again and choose Repair.");
            return false;
        }
        Log("Installing " + t.Name + " with winget (" + t.WingetId + "). This can take a few minutes...");
        string verb = t.Found == null ? "install" : "upgrade";
        int code = RunProcess(winget, verb + " --id " + t.WingetId + " --exact --source winget --accept-package-agreements --accept-source-agreements --silent --disable-interactivity", true);
        RefreshPath();
        t.Found = Probe(t);
        if (t.Ok) { Log(t.Name + " " + t.Found + " installed."); return true; }
        Log(t.Name + " could not be installed (winget exit code " + code + "). Install it yourself, then choose Repair.");
        return false;
    }

    // ------------------------------------------------------------------ uninstall
    void Uninstall(bool wipeData)
    {
        Log("Removing Repodeck from " + installDir);
        StopRunningApp();
        foreach (var lnk in Portable ? new string[0] : new[] { Path.Combine(StartMenuDir(), "Repodeck.lnk"), Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), "Repodeck.lnk") })
        {
            try { if (File.Exists(lnk)) { File.Delete(lnk); Log("Removed " + lnk); } } catch (Exception e) { Log("Could not remove " + lnk + ": " + e.Message); }
        }
        if (!Portable) { try { Registry.CurrentUser.DeleteSubKeyTree(RegKey, false); } catch { } try { Registry.CurrentUser.DeleteSubKeyTree(@"Software\Classes\AppUserModelId\Repodeck.App", false); } catch { } }
        if (wipeData) { DeleteDir(dataDir); }
        // Remove everything we can now; this running Setup.exe (if it lives in the folder) is removed right after exit.
        if (Directory.Exists(installDir))
        {
            string self = Path.GetFullPath(Application.ExecutablePath);
            foreach (var f in Directory.GetFiles(installDir, "*", SearchOption.AllDirectories))
            {
                if (string.Equals(Path.GetFullPath(f), self, StringComparison.OrdinalIgnoreCase)) continue;
                try { File.SetAttributes(f, FileAttributes.Normal); File.Delete(f); } catch { }
            }
            bool selfInside = self.StartsWith(Path.GetFullPath(installDir) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase);
            if (!selfInside) DeleteDir(installDir);
            else
            {
                Application.ApplicationExit += delegate
                {
                    try
                    {
                        var psi = new ProcessStartInfo(Environment.GetEnvironmentVariable("ComSpec") ?? "cmd.exe", "/d /c ping -n 3 127.0.0.1 >nul & rmdir /s /q \"" + installDir + "\"");
                        psi.CreateNoWindow = true; psi.UseShellExecute = false; psi.WorkingDirectory = Path.GetTempPath();
                        Process.Start(psi);
                    }
                    catch { }
                };
            }
        }
        if (wipeData) Log("Settings and safety copies deleted."); else Log("Settings kept in " + dataDir);
        if (!wipeData) Log("Done.");
    }

    // ------------------------------------------------------------------ helpers
    string ExistingInstallDir()
    {
        try
        {
            using (var k = Registry.CurrentUser.OpenSubKey(RegKey))
            {
                if (k != null) { var v = k.GetValue("InstallLocation") as string; if (!string.IsNullOrEmpty(v) && Directory.Exists(v)) return v; }
            }
        }
        catch { }
        return null;
    }
    bool IsInstalled() { return File.Exists(Path.Combine(installDir, "server", "main.js")); }
    string InstalledVersion()
    {
        try
        {
            string pkg = File.ReadAllText(Path.Combine(installDir, "package.json"));
            var m = Regex.Match(pkg, "\"version\"\\s*:\\s*\"([^\"]+)\"");
            if (m.Success) return m.Groups[1].Value;
        }
        catch { }
        return "";
    }
    static string StartMenuDir() { return Environment.GetFolderPath(Environment.SpecialFolder.Programs); }

    static string LegacyName { get { return "git" + "-helper"; } }
    static string LegacyDataDir() { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), LegacyName); }

    /// Ask every running window (one per account) to quit, including ones of the previous product name.
    void StopRunningApp()
    {
        foreach (var dir in new[] { dataDir, LegacyDataDir() })
        {
            if (!Directory.Exists(dir)) continue;
            foreach (var inst in Directory.GetFiles(dir, "instance*.json"))
            {
                try
                {
                    string json = File.ReadAllText(inst);
                    var port = Regex.Match(json, "\"port\"\\s*:\\s*(\\d+)");
                    var token = Regex.Match(json, "\"token\"\\s*:\\s*\"([0-9a-f]+)\"");
                    if (!port.Success || !token.Success) continue;
                    var req = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + port.Groups[1].Value + "/api/rpc");
                    req.Method = "POST"; req.ContentType = "application/json"; req.Timeout = 3000; req.Proxy = null;
                    req.Headers["X-Token"] = token.Groups[1].Value;
                    byte[] body = Encoding.UTF8.GetBytes("{\"method\":\"app.quit\"}");
                    using (var st = req.GetRequestStream()) st.Write(body, 0, body.Length);
                    using (req.GetResponse()) { }
                    Log("Stopped a running window.");
                    Thread.Sleep(900);
                }
                catch { /* not running */ }
            }
        }
    }

    /// The app used to be called something else: remove that install so only one remains. Settings are migrated by the app itself.
    void RemoveLegacy()
    {
        if (DirOverride != null || Portable) return;
        try
        {
            string key = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\" + LegacyName;
            string dir = null;
            using (var k = Registry.CurrentUser.OpenSubKey(key)) { if (k != null) dir = k.GetValue("InstallLocation") as string; }
            if (dir == null) dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", LegacyName);
            bool had = Directory.Exists(dir);
            foreach (var lnk in new[] { Path.Combine(StartMenuDir(), LegacyName + ".lnk"), Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), LegacyName + ".lnk") })
            {
                try { if (File.Exists(lnk)) File.Delete(lnk); } catch { }
            }
            try { Registry.CurrentUser.DeleteSubKeyTree(key, false); } catch { }
            if (had && !string.Equals(Path.GetFullPath(dir), Path.GetFullPath(installDir), StringComparison.OrdinalIgnoreCase)) { DeleteDir(dir); Log("Removed the previous version (" + LegacyName + ") from " + dir); }
        }
        catch (Exception e) { Log("Could not remove the previous version: " + e.Message); }
    }

    static void CreateShortcut(string lnk, string target)
    {
        Type t = Type.GetTypeFromProgID("WScript.Shell");
        object shell = Activator.CreateInstance(t);
        object sc = t.InvokeMember("CreateShortcut", BindingFlags.InvokeMethod, null, shell, new object[] { lnk });
        Type st = sc.GetType();
        st.InvokeMember("TargetPath", BindingFlags.SetProperty, null, sc, new object[] { target });
        st.InvokeMember("WorkingDirectory", BindingFlags.SetProperty, null, sc, new object[] { Path.GetDirectoryName(target) });
        st.InvokeMember("IconLocation", BindingFlags.SetProperty, null, sc, new object[] { target + ",0" });
        st.InvokeMember("Description", BindingFlags.SetProperty, null, sc, new object[] { "Repodeck: repositories, pull requests and GitHub Actions" });
        st.InvokeMember("Save", BindingFlags.InvokeMethod, null, sc, null);
    }

    static void DeleteDir(string dir)
    {
        if (!Directory.Exists(dir)) return;
        try
        {
            foreach (var f in Directory.GetFiles(dir, "*", SearchOption.AllDirectories)) { try { File.SetAttributes(f, FileAttributes.Normal); } catch { } }
            Directory.Delete(dir, true);
        }
        catch { }
    }
    static long DirSize(string dir)
    {
        long n = 0;
        try { foreach (var f in Directory.GetFiles(dir, "*", SearchOption.AllDirectories)) n += new FileInfo(f).Length; } catch { }
        return n;
    }

    static void RefreshPath()
    {
        var parts = new List<string>();
        foreach (var target in new[] { EnvironmentVariableTarget.Machine, EnvironmentVariableTarget.User })
        {
            string p = Environment.GetEnvironmentVariable("PATH", target);
            if (!string.IsNullOrEmpty(p)) parts.Add(Environment.ExpandEnvironmentVariables(p));
        }
        string pf = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
        parts.Add(Path.Combine(pf, "Git", "cmd")); parts.Add(Path.Combine(pf, "GitHub CLI")); parts.Add(Path.Combine(pf, "nodejs"));
        string nvm = Environment.GetEnvironmentVariable("NVM_SYMLINK");
        if (!string.IsNullOrEmpty(nvm)) parts.Add(nvm);
        parts.Add(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Microsoft", "WindowsApps"));
        Environment.SetEnvironmentVariable("PATH", string.Join(";", parts.ToArray()));
    }

    static string Which(string exe)
    {
        foreach (string d in (Environment.GetEnvironmentVariable("PATH") ?? "").Split(new[] { ';' }, StringSplitOptions.RemoveEmptyEntries))
        {
            try
            {
                foreach (var ext in new[] { ".exe", ".cmd" })
                {
                    string f = Path.Combine(d.Trim().Trim('"'), exe + ext);
                    if (File.Exists(f)) return f;
                }
            }
            catch { }
        }
        return null;
    }

    static Version Probe(Tool t)
    {
        // For checking the "tools missing" screens without uninstalling anything.
        string sim = Environment.GetEnvironmentVariable("REPODECK_SETUP_SIMULATE_MISSING");
        if (!string.IsNullOrEmpty(sim) && ("," + sim + ",").Contains("," + t.Exe + ",")) return null;
        string path = Which(t.Exe);
        if (path == null) return null;
        try
        {
            var psi = new ProcessStartInfo(path, t.Args) { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true };
            using (var p = Process.Start(psi))
            {
                string o = p.StandardOutput.ReadToEnd();
                p.WaitForExit(15000);
                var m = Regex.Match(o, t.Pattern);
                if (m.Success) return new Version(m.Groups[1].Value);
            }
        }
        catch { }
        return new Version(0, 0);
    }

    int RunProcess(string file, string args, bool logOutput)
    {
        var psi = new ProcessStartInfo(file, args) { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true, StandardOutputEncoding = Encoding.UTF8 };
        using (var p = new Process { StartInfo = psi })
        {
            DataReceivedEventHandler h = delegate(object s, DataReceivedEventArgs e)
            {
                if (!logOutput || string.IsNullOrWhiteSpace(e.Data)) return;
                string line = e.Data.Trim();
                // winget draws progress bars and spinners; keep only real text lines
                if (line.Length < 3 || Regex.IsMatch(line, @"^[\s\-\\|/█▒░]+") || Regex.IsMatch(line, @"^\d+(\.\d+)? ?(KB|MB|GB|%)")) return;
                Log("  " + line);
            };
            p.OutputDataReceived += h; p.ErrorDataReceived += h;
            p.Start();
            p.BeginOutputReadLine(); p.BeginErrorReadLine();
            p.WaitForExit();
            return p.ExitCode;
        }
    }
}

static class SetupProgram
{
    [STAThread]
    static int Main(string[] args)
    {
        ServicePointManager.Expect100Continue = false;
        string action = "";
        bool quiet = false;
        for (int i = 0; i < args.Length; i++)
        {
            string a = args[i];
            string x = a.TrimStart('/', '-').ToLowerInvariant();
            if (x == "dir" && i + 1 < args.Length) { SetupForm.DirOverride = Path.GetFullPath(args[++i]); continue; }
            if (x == "snapshot" && i + 1 < args.Length) { SetupForm.Snapshot = args[++i]; continue; }
            if (x == "portable") SetupForm.Portable = true;
            if (x == "uninstall" || x == "install" || x == "repair") action = x;
            if (x == "quiet" || x == "silent") quiet = true;
        }
        if (quiet && action == "") action = "install";
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        var form = new SetupForm(action, quiet);
        if (quiet) { form.WindowState = FormWindowState.Minimized; form.ShowInTaskbar = false; }
        Application.Run(form);
        return form.ExitCode;
    }
}
