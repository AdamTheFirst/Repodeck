// Repodeck Setup: install, update, repair and uninstall, for one user or for everyone on the computer.
// A per-user install needs no administrator rights; an install for everyone asks Windows for them once.
// Built with the C# compiler that ships with Windows (.NET Framework 4.x), so it runs on a clean machine.
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.IO.Compression;
using System.Net;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Principal;
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

static class Ui
{
    public static readonly Color Rail = Color.FromArgb(15, 22, 20);
    public static readonly Color Mint = Color.FromArgb(69, 214, 176);
    public static readonly Color Accent = Color.FromArgb(18, 135, 107);
    public static readonly Color AccentHover = Color.FromArgb(14, 116, 92);
    public static readonly Color Text = Color.FromArgb(27, 31, 36);
    public static readonly Color Muted = Color.FromArgb(91, 100, 112);
    public static readonly Color Border = Color.FromArgb(218, 223, 229);
    public static readonly Color Bar = Color.FromArgb(246, 247, 249);
    public static readonly Color Good = Color.FromArgb(31, 122, 67);
    public static readonly Color Bad = Color.FromArgb(180, 35, 44);
    public static readonly Color Warn = Color.FromArgb(154, 97, 0);

    public static GraphicsPath Round(Rectangle r, int radius)
    {
        int d = radius * 2;
        var p = new GraphicsPath();
        p.AddArc(r.X, r.Y, d, d, 180, 90);
        p.AddArc(r.Right - d, r.Y, d, d, 270, 90);
        p.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
        p.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
        p.CloseFigure();
        return p;
    }
}

/// A flat button in the app's colours. Primary = filled; the others are outlined.
class FlatBtn : Button
{
    public bool Primary, Danger;
    bool hot;
    public FlatBtn()
    {
        SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer, true);
        Cursor = Cursors.Hand;
    }
    protected override void OnMouseEnter(EventArgs e) { hot = true; Invalidate(); base.OnMouseEnter(e); }
    protected override void OnMouseLeave(EventArgs e) { hot = false; Invalidate(); base.OnMouseLeave(e); }
    protected override void OnEnabledChanged(EventArgs e) { Invalidate(); base.OnEnabledChanged(e); }
    protected override void OnPaint(PaintEventArgs e)
    {
        var g = e.Graphics;
        g.SmoothingMode = SmoothingMode.AntiAlias;
        g.Clear(Parent != null ? Parent.BackColor : Color.White);
        var r = new Rectangle(0, 0, Width - 1, Height - 1);
        Color fill = Primary ? (Danger ? Ui.Bad : Ui.Accent) : Color.White;
        if (hot && Enabled) fill = Primary ? (Danger ? Color.FromArgb(150, 28, 36) : Ui.AccentHover) : Color.FromArgb(240, 243, 246);
        if (!Enabled) fill = Primary ? Color.FromArgb(170, 205, 196) : Color.FromArgb(246, 247, 249);
        using (var path = Ui.Round(r, Height / 6))
        {
            using (var b = new SolidBrush(fill)) g.FillPath(b, path);
            if (!Primary) using (var p = new Pen(Focused ? Ui.Accent : Ui.Border)) g.DrawPath(p, path);
            else if (Focused) using (var p = new Pen(Color.FromArgb(120, 255, 255, 255))) { var inner = new Rectangle(2, 2, Width - 5, Height - 5); using (var ip = Ui.Round(inner, Height / 6)) g.DrawPath(p, ip); }
        }
        Color fg = Primary ? Color.White : (Enabled ? Ui.Text : Color.FromArgb(150, 156, 165));
        int imgW = Image != null ? Image.Width + 6 : 0;
        Size ts = TextRenderer.MeasureText(g, Text, Font, Size.Empty, TextFormatFlags.NoPadding);
        int x = (Width - ts.Width - imgW) / 2;
        if (Image != null) g.DrawImage(Image, x, (Height - Image.Height) / 2);
        TextRenderer.DrawText(g, Text, Font, new Point(x + imgW, (Height - ts.Height) / 2), fg, TextFormatFlags.NoPadding);
    }
}

/// A selectable card: a radio button with a title and a line of explanation.
class Choice : Control
{
    public string Title = "", Desc = "";
    public Image Badge;
    bool on, hot;
    public event EventHandler Picked;
    public bool Checked { get { return on; } set { on = value; Invalidate(); } }
    public Choice()
    {
        SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.Selectable, true);
        Cursor = Cursors.Hand; TabStop = true;
    }
    void Pick() { if (!Enabled) return; if (Parent != null) foreach (Control c in Parent.Controls) { var o = c as Choice; if (o != null && o != this) o.Checked = false; } Checked = true; if (Picked != null) Picked(this, EventArgs.Empty); }
    protected override void OnClick(EventArgs e) { Focus(); Pick(); base.OnClick(e); }
    protected override void OnKeyDown(KeyEventArgs e) { if (e.KeyCode == Keys.Space || e.KeyCode == Keys.Enter) Pick(); base.OnKeyDown(e); }
    protected override void OnMouseEnter(EventArgs e) { hot = true; Invalidate(); base.OnMouseEnter(e); }
    protected override void OnMouseLeave(EventArgs e) { hot = false; Invalidate(); base.OnMouseLeave(e); }
    protected override void OnGotFocus(EventArgs e) { Invalidate(); base.OnGotFocus(e); }
    protected override void OnLostFocus(EventArgs e) { Invalidate(); base.OnLostFocus(e); }
    protected override void OnPaint(PaintEventArgs e)
    {
        var g = e.Graphics;
        g.SmoothingMode = SmoothingMode.AntiAlias;
        g.Clear(Parent != null ? Parent.BackColor : Color.White);
        float k = DeviceDpi / 96f;
        var r = new Rectangle(1, 1, Width - 3, Height - 3);
        using (var path = Ui.Round(r, (int)(8 * k)))
        {
            using (var b = new SolidBrush(on ? Color.FromArgb(236, 248, 244) : (hot ? Color.FromArgb(248, 249, 251) : Color.White))) g.FillPath(b, path);
            using (var p = new Pen(on ? Ui.Accent : (Focused ? Ui.Accent : Ui.Border), on ? 2f : 1f)) g.DrawPath(p, path);
        }
        int cx = (int)(14 * k), cy = (int)(14 * k), d = (int)(16 * k);
        using (var p = new Pen(on ? Ui.Accent : Color.FromArgb(150, 156, 165), 1.6f)) g.DrawEllipse(p, cx, cy, d, d);
        if (on) using (var b = new SolidBrush(Ui.Accent)) g.FillEllipse(b, cx + d / 4f, cy + d / 4f, d / 2f, d / 2f);
        int tx = cx + d + (int)(10 * k);
        using (var f = new Font("Segoe UI Semibold", 9.5f))
        {
            TextRenderer.DrawText(g, Title, f, new Point(tx, (int)(11 * k)), Enabled ? Ui.Text : Ui.Muted, TextFormatFlags.NoPadding);
            if (Badge != null) { Size ts = TextRenderer.MeasureText(g, Title, f, Size.Empty, TextFormatFlags.NoPadding); g.DrawImage(Badge, tx + ts.Width + (int)(6 * k), (int)(12 * k)); }
        }
        TextRenderer.DrawText(g, Desc, Font, new Rectangle(tx, (int)(32 * k), Width - tx - (int)(10 * k), Height - (int)(36 * k)), Ui.Muted, TextFormatFlags.NoPadding | TextFormatFlags.WordBreak);
    }
}

class SetupForm : Form
{
    const string AppName = "Repodeck";
    const string RegKey = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\Repodeck";

    // Command line (see SetupProgram.Main)
    public static string DirOverride;    // /dir "<folder>": install somewhere else
    public static string DataDirOverride; // /datadir: the settings folder of the user who started Setup (kept across the administrator prompt)
    public static bool Portable;         // /portable: no shortcuts, no Installed apps entry
    public static bool AllUsersArg;      // /allusers: install for everyone (needs administrator rights)
    public static bool DesktopArg, NoToolsArg, WipeArg;
    public static string AutoRun;        // /run <action>: start that action at once, with the window (used after the administrator prompt)
    public static string Snapshot, SnapshotPage; // /snapshot <png> [/page <name>]: save a picture of a page and exit (layout checks)

    string installDir;
    bool machine;                        // true = for everyone on this computer
    readonly string dataDir;
    readonly List<Tool> tools = new List<Tool>();
    readonly bool silent;
    readonly string startAction;
    public int ExitCode;

    Panel rail, content, bar;
    FlatBtn btnBack, btnNext, btnCancel;
    Action onNext, onBack;
    string[] steps = new string[0];
    int stepIndex;
    Image logo, shield;
    TextBox log;
    ProgressBar progress;
    Label progressText;
    readonly StringBuilder logText = new StringBuilder();
    bool busy;
    string installedVersion;
    // choices made on the pages
    bool wantDesktop, wantTools = true, wipeData;

    int S(int v) { return (int)Math.Round(v * DeviceDpi / 96.0); }

    public SetupForm(string action, bool silent)
    {
        this.silent = silent;
        this.startAction = action;
        dataDir = DataDirOverride ?? Environment.GetEnvironmentVariable("REPODECK_DATA") ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Repodeck");
        Detect();
        wantDesktop = DesktopArg; wantTools = !NoToolsArg; wipeData = WipeArg;
        tools.Add(new Tool { Name = "Git", Exe = "git", Args = "--version", Pattern = @"(\d+\.\d+\.\d+)", Min = new Version(2, 30, 0), WingetId = "Git.Git" });
        tools.Add(new Tool { Name = "GitHub CLI", Exe = "gh", Args = "--version", Pattern = @"(\d+\.\d+\.\d+)", Min = new Version(2, 40, 0), WingetId = "GitHub.cli" });
        tools.Add(new Tool { Name = "Node.js", Exe = "node", Args = "--version", Pattern = @"v(\d+\.\d+\.\d+)", Min = new Version(20, 0, 0), WingetId = "OpenJS.NodeJS.LTS" });
        BuildUi();
        Shown += delegate
        {
            ProbeTools();
            installedVersion = InstalledVersion();
            if (Snapshot != null) { ShowSnapshotPage(); return; }
            if (silent) { Run(startAction); return; }
            if (AutoRun != null) { Run(AutoRun); return; }
            if (startAction == "uninstall" && IsInstalled()) PageUninstall();
            else if (IsInstalled()) PageMaintenance();
            else PageWelcome();
        };
    }

    /// Where is it installed, and for whom? An existing install decides; otherwise the command line or the default.
    void Detect()
    {
        string m = ExistingInstallDir(true), u = ExistingInstallDir(false);
        if (DirOverride != null) { installDir = DirOverride; machine = AllUsersArg; }
        else if (m != null) { installDir = m; machine = true; }
        else if (u != null) { installDir = u; machine = false; }
        else { machine = AllUsersArg; installDir = DefaultDir(machine); }
    }
    static string DefaultDir(bool forEveryone)
    {
        if (!forEveryone) return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "Repodeck");
        string pf = Environment.GetEnvironmentVariable("ProgramW6432");
        if (string.IsNullOrEmpty(pf)) pf = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
        return Path.Combine(pf, "Repodeck");
    }
    static bool IsElevated()
    {
        try { using (var id = WindowsIdentity.GetCurrent()) return new WindowsPrincipal(id).IsInRole(WindowsBuiltInRole.Administrator); } catch { return false; }
    }

    // ------------------------------------------------------------------ window
    void BuildUi()
    {
        Text = AppName + " Setup";
        Font = new Font("Segoe UI", 9f);
        AutoScaleMode = AutoScaleMode.None;
        ClientSize = new Size(S(720), S(480));
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        StartPosition = FormStartPosition.CenterScreen;
        BackColor = Color.White;
        try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }
        try { using (var s = Assembly.GetExecutingAssembly().GetManifestResourceStream("logo.png")) if (s != null) logo = Image.FromStream(s); } catch { }
        try { shield = new Bitmap(SystemIcons.Shield.ToBitmap(), new Size(S(16), S(16))); } catch { }

        rail = new Panel { Location = new Point(0, 0), Size = new Size(S(200), S(480)), BackColor = Ui.Rail };
        rail.Paint += PaintRail;
        bar = new Panel { Location = new Point(S(200), S(420)), Size = new Size(S(520), S(60)), BackColor = Ui.Bar };
        bar.Paint += delegate(object s, PaintEventArgs e) { using (var p = new Pen(Ui.Border)) e.Graphics.DrawLine(p, 0, 0, bar.Width, 0); };
        content = new Panel { Location = new Point(S(200), 0), Size = new Size(S(520), S(420)), BackColor = Color.White };
        Controls.Add(rail); Controls.Add(bar); Controls.Add(content);

        btnBack = MakeBarButton("Back", false);
        btnNext = MakeBarButton("Next", true);
        btnCancel = MakeBarButton("Cancel", false);
        btnBack.Click += delegate { if (onBack != null) onBack(); };
        btnNext.Click += delegate { if (onNext != null) onNext(); };
        btnCancel.Click += delegate { Close(); };
        FormClosing += delegate(object s, FormClosingEventArgs e) { if (busy) e.Cancel = true; };
    }

    FlatBtn MakeBarButton(string text, bool primary)
    {
        var b = new FlatBtn { Text = text, Primary = primary, Size = new Size(S(96), S(32)), Font = primary ? new Font("Segoe UI Semibold", 9f) : Font };
        bar.Controls.Add(b);
        return b;
    }

    /// Right-aligned bar buttons. Any of them can be null (hidden).
    void Buttons(string back, string next, string cancel, bool nextShield = false, bool nextDanger = false)
    {
        btnBack.Visible = back != null; btnNext.Visible = next != null; btnCancel.Visible = cancel != null;
        if (back != null) btnBack.Text = back;
        if (cancel != null) btnCancel.Text = cancel;
        if (next != null)
        {
            btnNext.Text = next; btnNext.Danger = nextDanger; btnNext.Image = nextShield ? shield : null;
            Size ts = TextRenderer.MeasureText(next, btnNext.Font);
            btnNext.Width = Math.Max(S(96), ts.Width + S(34) + (nextShield ? S(22) : 0));
        }
        int x = bar.Width - S(20);
        foreach (var b in new[] { btnCancel, btnNext, btnBack })
        {
            if (!b.Visible) continue;
            x -= b.Width; b.Location = new Point(x, S(14)); x -= S(8);
        }
        AcceptButton = btnNext.Visible ? (IButtonControl)btnNext : btnCancel;
        CancelButton = btnCancel.Visible ? btnCancel : null;
        btnNext.Invalidate();
    }

    void PaintRail(object sender, PaintEventArgs e)
    {
        var g = e.Graphics;
        g.SmoothingMode = SmoothingMode.AntiAlias;
        g.InterpolationMode = InterpolationMode.HighQualityBicubic;
        if (logo != null) g.DrawImage(logo, new Rectangle(S(24), S(28), S(44), S(44)));
        using (var f = new Font("Segoe UI Semibold", 15f)) TextRenderer.DrawText(g, AppName, f, new Point(S(22), S(84)), Color.White, TextFormatFlags.NoPadding);
        TextRenderer.DrawText(g, "Version " + BuildInfo.Version, Font, new Point(S(24), S(116)), Color.FromArgb(140, 160, 154), TextFormatFlags.NoPadding);
        int y = S(176);
        for (int i = 0; i < steps.Length; i++)
        {
            bool cur = i == stepIndex, done = i < stepIndex;
            int d = S(8);
            using (var b = new SolidBrush(cur || done ? Ui.Mint : Color.FromArgb(70, 84, 80))) g.FillEllipse(b, S(26), y + S(5), d, d);
            if (i < steps.Length - 1) using (var p = new Pen(done ? Ui.Mint : Color.FromArgb(50, 62, 59), 1.5f)) g.DrawLine(p, S(26) + d / 2f, y + S(5) + d + S(3), S(26) + d / 2f, y + S(30));
            using (var f = new Font(cur ? "Segoe UI Semibold" : "Segoe UI", 9.5f))
                TextRenderer.DrawText(g, steps[i], f, new Point(S(46), y), cur ? Color.White : (done ? Color.FromArgb(190, 205, 200) : Color.FromArgb(120, 136, 131)), TextFormatFlags.NoPadding);
            y += S(34);
        }
    }

    static readonly string[] InstallSteps = { "Welcome", "Location", "Tools", "Install", "Finish" };
    void Steps(int index, params string[] names) { steps = names; stepIndex = index; rail.Invalidate(); }

    // ------------------------------------------------------------------ page building blocks
    void Clear() { content.SuspendLayout(); while (content.Controls.Count > 0) { var c = content.Controls[0]; content.Controls.RemoveAt(0); if (c != log && c != progress) c.Dispose(); } content.ResumeLayout(); }

    Label Heading(string title, string sub)
    {
        var t = new Label { Text = title, Font = new Font("Segoe UI Semibold", 15f), ForeColor = Ui.Text, Location = new Point(S(32), S(30)), Size = new Size(S(456), S(34)), AutoEllipsis = true };
        content.Controls.Add(t);
        // Controls added earlier are drawn on top of later ones, so an empty subtitle must not exist at all:
        // it would cover whatever a page puts in that space.
        if (string.IsNullOrEmpty(sub)) return null;
        var s = new Label { Text = sub, ForeColor = Ui.Muted, Location = new Point(S(34), S(68)), Size = new Size(S(452), S(36)) };
        content.Controls.Add(s);
        return s;
    }
    Label Para(string text, int y, int h, Color? color = null, Font font = null)
    {
        var l = new Label { Text = text, ForeColor = color ?? Ui.Text, Location = new Point(S(34), S(y)), Size = new Size(S(452), S(h)) };
        if (font != null) l.Font = font;
        content.Controls.Add(l);
        return l;
    }
    Label Caption(string text, int y)
    {
        var l = new Label { Text = text, Font = new Font("Segoe UI Semibold", 9f), ForeColor = Ui.Text, Location = new Point(S(34), S(y)), AutoSize = true };
        content.Controls.Add(l);
        return l;
    }
    CheckBox Check(string text, int y, bool value, EventHandler changed)
    {
        var c = new CheckBox { Text = text, Location = new Point(S(34), S(y)), AutoSize = true, Checked = value, ForeColor = Ui.Text };
        if (changed != null) c.CheckedChanged += changed;
        content.Controls.Add(c);
        return c;
    }
    Choice Card(string title, string desc, int x, int y, int w, int h, bool on)
    {
        var c = new Choice { Title = title, Desc = desc, Location = new Point(S(x), S(y)), Size = new Size(S(w), S(h)), Font = Font };
        content.Controls.Add(c);
        c.Checked = on;
        return c;
    }
    /// The list of required tools with a tick or a cross each. Returns the height used.
    int ToolRows(int y)
    {
        foreach (var t in tools)
        {
            content.Controls.Add(new Label { Text = t.Ok ? "✔" : "✖", ForeColor = t.Ok ? Ui.Good : Ui.Bad, Location = new Point(S(36), S(y)), Size = new Size(S(18), S(20)) });
            content.Controls.Add(new Label { Text = t.Name, ForeColor = Ui.Text, Location = new Point(S(58), S(y)), Size = new Size(S(100), S(20)) });
            content.Controls.Add(new Label { Text = t.Found == null ? "not installed" : (t.Ok ? "version " + t.Found : "version " + t.Found + " is too old (needs " + t.Min + ")"), ForeColor = t.Ok ? Ui.Muted : Ui.Bad, Location = new Point(S(160), S(y)), Size = new Size(S(326), S(20)) });
            y += 22;
        }
        return y;
    }
    void ProbeTools() { RefreshPath(); foreach (var t in tools) t.Found = Probe(t); }
    bool AnyToolMissing() { foreach (var t in tools) if (!t.Ok) return true; return false; }
    string ScopeText() { return machine ? "for everyone on this computer" : "for you only"; }

    // ------------------------------------------------------------------ pages
    void PageWelcome()
    {
        Clear(); Steps(0, InstallSteps);
        Heading("Welcome to Repodeck Setup", "Version " + BuildInfo.Version);
        Para("Repodeck shows all your git repositories in one window: source control, commit graph, pull requests and GitHub Actions.", 112, 40);
        Para("Setup will:", 166, 20, null, new Font("Segoe UI Semibold", 9f));
        Para("•  copy the app to this computer and add it to the Start menu\n•  check for Git, GitHub CLI and Node.js, and offer to install what is missing\n•  never change your repositories or your git settings", 190, 64, Ui.Muted);
        Para("You sign in to GitHub later, inside the app.", 270, 20, Ui.Muted);
        onBack = null; onNext = PageOptions;
        Buttons(null, "Next", "Cancel");
        btnNext.Focus();
    }

    bool customDir;

    void PageOptions()
    {
        Clear(); Steps(1, InstallSteps);
        Heading("Who is it for, and where?", "Choose who can use Repodeck on this computer.");
        var me = Card("Just me", "No administrator rights needed. Installed in your user profile.", 34, 116, 452, 58, !machine);
        var all = Card("All users", "Needs administrator rights. Installed in Program Files.", 34, 182, 452, 58, machine);
        all.Badge = shield;

        Caption("Folder", 262);
        var folder = new TextBox { Text = installDir, ReadOnly = true, BorderStyle = BorderStyle.FixedSingle, BackColor = Color.FromArgb(250, 251, 252), Location = new Point(S(34), S(286)), Size = new Size(S(352), S(24)) };
        content.Controls.Add(folder);
        var change = new FlatBtn { Text = "Change…", Location = new Point(S(394), S(285)), Size = new Size(S(92), S(26)), Font = Font };
        content.Controls.Add(change);
        Para("Repodeck always gets its own folder named Repodeck.", 318, 20, Ui.Muted);
        if (DirOverride != null) customDir = true;
        Action sync = delegate
        {
            if (!customDir) installDir = DefaultDir(machine);
            folder.Text = installDir;
        };
        me.Picked += delegate { machine = false; sync(); };
        all.Picked += delegate { machine = true; sync(); };
        change.Click += delegate
        {
            using (var d = new FolderBrowserDialog { Description = "Repodeck is installed in a folder named Repodeck inside the folder you choose.", ShowNewFolderButton = true })
            {
                if (d.ShowDialog(this) != DialogResult.OK) return;
                string p = d.SelectedPath;
                // Always its own folder, so that uninstalling can never remove anything else.
                if (!string.Equals(Path.GetFileName(p.TrimEnd('\\')), "Repodeck", StringComparison.OrdinalIgnoreCase)) p = Path.Combine(p, "Repodeck");
                string problem = FolderProblem(p);
                if (problem != null) { MessageBox.Show(this, problem + "\n\nChoose another folder.", AppName + " Setup", MessageBoxButtons.OK, MessageBoxIcon.Warning); return; }
                installDir = p; customDir = true; DirOverride = p; sync();
            }
        };
        onBack = PageWelcome; onNext = PageTools;
        sync();
        Buttons("Back", "Next", "Cancel");
        btnNext.Focus();
    }

    /// Why Repodeck cannot be installed in this folder, or null when it can.
    string FolderProblem(string dir)
    {
        try
        {
            if (Directory.Exists(dir))
            {
                bool ours = File.Exists(Path.Combine(dir, "server", "main.js"));
                if (!ours && Directory.GetFileSystemEntries(dir).Length > 0) return "The folder\n" + dir + "\nalready contains other files. Repodeck needs a folder of its own.";
            }
            if (machine && !IsElevated()) return null; // Program Files and the like: checked after the administrator prompt
            string probeDir = dir;
            while (!Directory.Exists(probeDir)) { string up = Path.GetDirectoryName(probeDir); if (string.IsNullOrEmpty(up)) return "The drive for\n" + dir + "\ndoes not exist."; probeDir = up; }
            string probe = Path.Combine(probeDir, ".repodeck-write-test-" + Guid.NewGuid().ToString("N"));
            File.WriteAllText(probe, "");
            File.Delete(probe);
            return null;
        }
        catch (Exception)
        {
            return "Windows does not allow writing to\n" + dir + "\nIt may be read-only, or need administrator rights.";
        }
    }

    void PageTools()
    {
        Clear(); Steps(2, InstallSteps);
        bool missing = AnyToolMissing();
        Heading("Tools and shortcuts", missing ? "Repodeck needs the tools below. The missing ones can be installed for you." : "Repodeck needs the tools below. They are all present.");
        Caption("Required tools", 116);
        int y = ToolRows(140) + 8;
        if (missing)
        {
            Check("Download and install the missing tools from their official sources", y, wantTools, delegate(object s, EventArgs e) { wantTools = ((CheckBox)s).Checked; });
            y += 24;
            Para("Without them Repodeck is installed but cannot start. You can add them later and run Setup again.", y, 34, Ui.Muted);
            y += 44;
        }
        y += 10;
        if (!Portable)
        {
            Caption("Shortcuts", y); y += 24;
            Para("A Start menu entry is always added.", y, 20, Ui.Muted); y += 24;
            Check("Also create a desktop shortcut", y, wantDesktop, delegate(object s, EventArgs e) { wantDesktop = ((CheckBox)s).Checked; });
        }
        onBack = PageOptions; onNext = delegate { Run("install"); };
        Buttons("Back", "Install", "Cancel", machine && !IsElevated());
        btnNext.Focus();
    }

    void PageMaintenance()
    {
        Clear(); Steps(0, "Choose", "Working", "Finish");
        bool same = installedVersion == BuildInfo.Version;
        Heading("Repodeck " + installedVersion + " is installed", "Installed " + ScopeText() + " in\n" + installDir);
        Caption("What would you like to do?", 120);
        var fix = Card(same ? "Repair" : "Update to version " + BuildInfo.Version, same ? "Replaces the program files and shortcuts. Your settings are kept." : "Replaces the program files with version " + BuildInfo.Version + ". Your settings are kept.", 34, 144, 452, 62, true);
        var remove = Card("Uninstall", "Removes the app and its shortcuts. Your repositories are not touched.", 34, 214, 452, 62, false);
        Caption("Required tools", 292);
        ToolRows(314);
        bool needShield = machine && !IsElevated();
        onBack = null;
        onNext = delegate { if (remove.Checked) PageUninstall(); else Run("repair"); };
        Action relabel = delegate { Buttons(null, remove.Checked ? "Next" : (same ? "Repair" : "Update"), "Close", needShield && !remove.Checked); };
        fix.Picked += delegate { relabel(); }; remove.Picked += delegate { relabel(); };
        relabel();
        btnNext.Focus();
    }

    void PageUninstall()
    {
        Clear(); Steps(0, "Choose", "Working", "Finish");
        Heading("Uninstall Repodeck " + installedVersion + "?", "Installed " + ScopeText() + " in\n" + installDir);
        Para("This removes the program files, the shortcuts and the entry in Installed apps.", 124, 20);
        Para("•  Your repositories are not touched.\n•  Git, GitHub CLI and Node.js stay installed.\n•  Your settings are kept, unless you tick the box below.", 150, 60, Ui.Muted);
        Check("Also delete my settings, logs and safety copies of discarded changes", 222, wipeData, delegate(object s, EventArgs e) { wipeData = ((CheckBox)s).Checked; });
        onBack = startAction == "uninstall" ? (Action)null : PageMaintenance;
        onNext = delegate { Run("uninstall"); };
        Buttons(startAction == "uninstall" ? null : "Back", "Uninstall", "Cancel", machine && !IsElevated(), true);
        btnCancel.Focus();
    }

    void PageProgress(string action)
    {
        Clear();
        if (action == "install") Steps(3, InstallSteps); else Steps(1, "Choose", "Working", "Finish");
        Heading(action == "uninstall" ? "Removing Repodeck…" : (action == "repair" ? (installedVersion == BuildInfo.Version ? "Repairing Repodeck…" : "Updating Repodeck…") : "Installing Repodeck…"), "This usually takes a few seconds. Installing missing tools can take a few minutes.");
        progressText = Para("Starting…", 122, 20);
        if (progress == null) progress = new ProgressBar { Minimum = 0, Maximum = 100 };
        progress.Location = new Point(S(34), S(148)); progress.Size = new Size(S(452), S(8)); progress.Style = ProgressBarStyle.Marquee; progress.MarqueeAnimationSpeed = 25;
        content.Controls.Add(progress);
        AddLog(176, 224, true);
        onBack = null; onNext = null;
        Buttons(null, null, "Cancel");
        btnCancel.Enabled = false;
    }

    void AddLog(int y, int h, bool visible)
    {
        if (log == null) log = new TextBox { Multiline = true, ReadOnly = true, ScrollBars = ScrollBars.Vertical, BackColor = Color.FromArgb(250, 251, 252), BorderStyle = BorderStyle.FixedSingle, Font = new Font("Consolas", 8.5f) };
        log.Location = new Point(S(34), S(y)); log.Size = new Size(S(452), S(h)); log.Visible = visible;
        log.Text = logText.ToString(); log.SelectionStart = log.TextLength; log.ScrollToCaret();
        content.Controls.Add(log);
    }

    void PageFinish(string action, string error, bool toolsMissing)
    {
        Clear();
        if (action == "install") Steps(4, InstallSteps); else Steps(2, "Choose", "Working", "Finish");
        bool ok = error == null && !toolsMissing;
        string title = error != null ? "Something went wrong" : action == "uninstall" ? "Repodeck was removed" : toolsMissing ? "Installed, but tools are missing" : action == "repair" ? "Repodeck is up to date" : "Repodeck is installed";
        Color tone = error != null ? Ui.Bad : toolsMissing ? Ui.Warn : Ui.Good;
        var mark = new Panel { Location = new Point(S(34), S(32)), Size = new Size(S(40), S(40)), BackColor = Color.White };
        mark.Paint += delegate(object s, PaintEventArgs e)
        {
            var g = e.Graphics; g.SmoothingMode = SmoothingMode.AntiAlias;
            using (var b = new SolidBrush(tone)) g.FillEllipse(b, 0, 0, mark.Width - 1, mark.Height - 1);
            using (var p = new Pen(Color.White, S(3)) { StartCap = LineCap.Round, EndCap = LineCap.Round, LineJoin = LineJoin.Round })
            {
                float w = mark.Width;
                if (ok) g.DrawLines(p, new[] { new PointF(w * .28f, w * .52f), new PointF(w * .44f, w * .68f), new PointF(w * .73f, w * .34f) });
                else { g.DrawLine(p, w * .5f, w * .24f, w * .5f, w * .58f); g.DrawLine(p, w * .5f, w * .74f, w * .5f, w * .75f); }
            }
        };
        content.Controls.Add(mark);
        content.Controls.Add(new Label { Text = title, Font = new Font("Segoe UI Semibold", 15f), ForeColor = Ui.Text, Location = new Point(S(86), S(35)), Size = new Size(S(400), S(34)) });
        int y = 92;
        if (error != null)
        {
            Para(error, y, 56, Ui.Bad); y += 62;
            Para("Nothing else was changed. The details are below and in\n" + Path.Combine(dataDir, "install.log"), y, 36, Ui.Muted); y += 44;
            AddLog(y, 400 - y, true);
        }
        else if (action == "uninstall")
        {
            Para("The app, its shortcuts and its entry in Installed apps are gone.", y, 20); y += 26;
            Para((wipeData ? "Your settings were deleted too." : "Your settings were kept in\n" + dataDir) + "\n\nGit, GitHub CLI and Node.js are still installed.", y, 80, Ui.Muted);
        }
        else if (toolsMissing)
        {
            Para("Repodeck cannot run until the tools marked below are installed.\nInstall them, then run Setup again and choose Repair.", y, 40, Ui.Warn); y += 50;
            y = ToolRows(y) + 8;
            AddLog(y, 400 - y, true);
        }
        else
        {
            Para("Version " + BuildInfo.Version + ", installed " + ScopeText() + ".", y, 20); y += 26;
            Para("You will find Repodeck in the Start menu" + (wantDesktop && action == "install" ? " and on the desktop" : "") + ".\nNothing was started: open it when you are ready.", y, 40, Ui.Muted); y += 60;
            var details = new LinkLabel { Text = "Show details", Location = new Point(S(34), S(y)), AutoSize = true, LinkColor = Ui.Accent, ActiveLinkColor = Ui.AccentHover, LinkBehavior = LinkBehavior.HoverUnderline };
            content.Controls.Add(details);
            AddLog(y + 24, 400 - y - 24, false);
            details.Click += delegate { log.Visible = !log.Visible; details.Text = log.Visible ? "Hide details" : "Show details"; };
        }
        onBack = null;
        btnCancel.Enabled = true;
        if (ok && action != "uninstall") { onNext = delegate { StartApp(); Close(); }; Buttons(null, "Open Repodeck", "Close"); btnNext.Focus(); }
        else { onNext = null; Buttons(null, null, "Close"); btnCancel.Focus(); }
    }

    void ShowSnapshotPage()
    {
        string p = SnapshotPage ?? "";
        if (p == "options") PageOptions();
        else if (p == "tools") PageTools();
        else if (p == "maintenance") { if (installedVersion == "") installedVersion = BuildInfo.Version; PageMaintenance(); }
        else if (p == "uninstall") { if (installedVersion == "") installedVersion = BuildInfo.Version; PageUninstall(); }
        else if (p == "progress") { PageProgress("install"); logText.AppendLine("Installing Repodeck " + BuildInfo.Version + " in " + installDir); log.Text = logText.ToString(); progressText.Text = "Copying files…"; }
        else if (p == "finish") PageFinish("install", null, false);
        else if (p == "error") { logText.AppendLine("FAILED: example"); PageFinish("install", "Access to the folder was denied.", false); }
        else PageWelcome();
        TopMost = true; Activate(); Refresh(); Application.DoEvents();
        var t = new System.Windows.Forms.Timer { Interval = 700 };
        t.Tick += delegate
        {
            t.Stop();
            // a photograph of the real window, exactly as it appears on screen
            using (var bmp = new Bitmap(Width, Height)) { using (var g = Graphics.FromImage(bmp)) g.CopyFromScreen(Location, Point.Empty, Size); bmp.Save(Snapshot, System.Drawing.Imaging.ImageFormat.Png); }
            Close();
        };
        t.Start();
    }

    // ------------------------------------------------------------------ run
    void Log(string line)
    {
        if (InvokeRequired) { BeginInvoke(new Action<string>(Log), line); return; }
        logText.AppendLine(line);
        if (log != null && !log.IsDisposed) log.AppendText(line + Environment.NewLine);
        try { Directory.CreateDirectory(dataDir); File.AppendAllText(Path.Combine(dataDir, "install.log"), DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + "  " + line + Environment.NewLine); } catch { }
    }

    /// What is happening now, and how far along (percent; below zero = unknown).
    void Step(string text, int percent)
    {
        if (InvokeRequired) { BeginInvoke(new Action<string, int>(Step), text, percent); return; }
        if (progressText != null && !progressText.IsDisposed && text != null) progressText.Text = text;
        if (progress == null || progress.IsDisposed) return;
        if (percent < 0) { if (progress.Style != ProgressBarStyle.Marquee) progress.Style = ProgressBarStyle.Marquee; }
        else { if (progress.Style != ProgressBarStyle.Continuous) progress.Style = ProgressBarStyle.Continuous; progress.Value = Math.Max(0, Math.Min(100, percent)); }
    }

    string ElevatedArgs(string action)
    {
        var a = new StringBuilder();
        a.Append("/run ").Append(action).Append(" /allusers /datadir \"").Append(dataDir.TrimEnd('\\')).Append("\" /dir \"").Append(installDir.TrimEnd('\\')).Append("\"");
        if (wantDesktop) a.Append(" /desktop");
        if (!wantTools) a.Append(" /notools");
        if (wipeData) a.Append(" /wipedata");
        if (Portable) a.Append(" /portable");
        return a.ToString();
    }

    void Run(string action)
    {
        if (busy) return;
        // For everyone = Program Files and the machine's registry: Windows asks for administrator rights once,
        // and the work continues in that elevated copy of Setup.
        if (machine && !IsElevated() && !Portable)
        {
            try
            {
                var psi = new ProcessStartInfo(Application.ExecutablePath, ElevatedArgs(action) + (silent ? " /quiet" : "")) { UseShellExecute = true, Verb = "runas" };
                using (var p = Process.Start(psi))
                {
                    if (silent) { p.WaitForExit(); ExitCode = p.ExitCode; }
                }
                Close();
            }
            catch (Win32Exception)
            {
                if (silent) { ExitCode = 5; Close(); return; }
                MessageBox.Show(this, "Administrator permission was not given, so nothing was changed.\n\nTo install without it, choose \"Just me\".", AppName + " Setup", MessageBoxButtons.OK, MessageBoxIcon.Information);
            }
            return;
        }
        if (action == "install")
        {
            string problem = FolderProblem(installDir);
            if (problem != null)
            {
                if (silent) { Log(problem.Replace("\n", " ")); ExitCode = 1; Close(); return; }
                MessageBox.Show(this, problem + "\n\nGo back and choose another folder.", AppName + " Setup", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }
        }
        busy = true;
        if (action != "uninstall" && installedVersion == null) installedVersion = "";
        PageProgress(action);
        bool tools = wantTools, desktop = wantDesktop, wipe = wipeData;
        var worker = new Thread(delegate()
        {
            string error = null;
            bool toolsMissing = false;
            try
            {
                if (action == "uninstall") Uninstall(wipe);
                else toolsMissing = !Install(tools, desktop, action == "repair");
            }
            catch (UnauthorizedAccessException e) { error = "Windows did not allow writing to\n" + installDir + "\nThe folder may be read-only, or a file in it is in use."; Log("FAILED: " + e); }
            catch (Exception e) { error = e.Message; Log("FAILED: " + e); }
            BeginInvoke(new Action(delegate { Finished(action, error, toolsMissing); }));
        });
        worker.IsBackground = true;
        worker.SetApartmentState(ApartmentState.STA);
        worker.Start();
    }

    void Finished(string action, string error, bool toolsMissing)
    {
        busy = false;
        ExitCode = error != null ? 1 : 0;
        if (silent) { Close(); return; }
        Step(null, 100);
        PageFinish(action, error, toolsMissing);
    }

    void StartApp()
    {
        string exe = Path.Combine(installDir, "Repodeck.exe");
        try
        {
            // Setup may be running as administrator; the app must not. Explorer starts it as the signed-in user.
            if (IsElevated()) Process.Start(new ProcessStartInfo("explorer.exe", "\"" + exe + "\"") { UseShellExecute = false });
            else Process.Start(new ProcessStartInfo(exe) { WorkingDirectory = installDir, UseShellExecute = false });
        }
        catch (Exception e) { Log("Could not start Repodeck: " + e.Message); }
    }

    // ------------------------------------------------------------------ install / repair
    /// <returns>true when every required tool is present afterwards</returns>
    bool Install(bool installTools, bool desktop, bool repair)
    {
        Log((repair ? "Repairing" : "Installing") + " Repodeck " + BuildInfo.Version + " in " + installDir + " (" + ScopeText() + ")");
        Step("Closing Repodeck if it is running…", -1);
        StopRunningApp();
        RemoveLegacy();
        if (machine) RemovePerUserCopy();

        bool allOk = true;
        foreach (var t in tools)
        {
            if (t.Ok) continue;
            if (!installTools) { Log(t.Name + " is missing and was not installed (option unchecked)."); allOk = false; continue; }
            Step("Installing " + t.Name + "…", -1);
            if (!InstallTool(t)) allOk = false;
        }

        Step("Copying files…", 0);
        Log("Copying files...");
        Directory.CreateDirectory(installDir);
        foreach (var d in new[] { "server", "ui", "installer" }) DeleteDir(Path.Combine(installDir, d)); // "installer" = leftovers of the old script installer
        using (var s = Assembly.GetExecutingAssembly().GetManifestResourceStream("payload.zip"))
        {
            if (s == null) throw new Exception("This Setup file is incomplete (no payload). Download it again.");
            using (var zip = new ZipArchive(s, ZipArchiveMode.Read))
            {
                int n = 0, total = Math.Max(1, zip.Entries.Count);
                foreach (var entry in zip.Entries)
                {
                    if (++n % 8 == 0) Step(null, n * 90 / total);
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
        Step("Creating shortcuts…", 94);
        Log("Creating shortcuts...");
        CreateShortcut(Path.Combine(StartMenuDir(machine), "Repodeck.lnk"), exe);
        if (desktop) CreateShortcut(Path.Combine(DesktopDir(machine), "Repodeck.lnk"), exe);

        using (var hive = Hive(machine))
        using (var k = hive.CreateSubKey(RegKey))
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
            k.SetValue("InstallScope", machine ? "machine" : "user");
            k.SetValue("EstimatedSize", (int)(DirSize(installDir) / 1024), RegistryValueKind.DWord);
        }
        // Notifications appear under the app's own name and icon instead of "Windows PowerShell".
        try { Registry.CurrentUser.DeleteSubKeyTree(@"Software\Classes\AppUserModelId\Repodeck.App", false); } catch { } // name used by earlier builds
        using (var hive = Hive(machine))
        using (var k = hive.CreateSubKey(@"Software\Classes\AppUserModelId\" + AppId))
        {
            k.SetValue("DisplayName", AppName);
            k.SetValue("IconUri", Path.Combine(installDir, "ui", "icon-256.png"));
        }
        try { SHChangeNotify(0x08000000, 0, IntPtr.Zero, IntPtr.Zero); } catch { } // tell Windows its cached icons may be out of date
        Step("Done", 100);
        Log(allOk ? "Done." : "Done, but some required tools are missing. Repodeck will tell you which when it starts.");
        return allOk;
    }

    bool InstallTool(Tool t)
    {
        string winget = Which("winget");
        if (winget == null) return InstallToolDirect(t); // no winget on this computer: fetch the official installer ourselves
        Log("Installing " + t.Name + " with winget (" + t.WingetId + "). This can take a few minutes...");
        string verb = t.Found == null ? "install" : "upgrade";
        int code = RunProcess(winget, verb + " --id " + t.WingetId + " --exact --source winget --accept-package-agreements --accept-source-agreements --silent --disable-interactivity", true);
        RefreshPath();
        t.Found = Probe(t);
        if (t.Ok) { Log(t.Name + " " + t.Found + " installed."); return true; }
        Log(t.Name + " could not be installed (winget exit code " + code + "). Install it yourself, then choose Repair.");
        return false;
    }

    /// Without winget: download the tool's own installer from its official site, check it, and run it.
    bool InstallToolDirect(Tool t)
    {
        string dir = Path.Combine(Path.GetTempPath(), "RepodeckSetup-" + Guid.NewGuid().ToString("N"));
        try
        {
            Directory.CreateDirectory(dir);
            ServicePointManager.SecurityProtocol = SecurityProtocolType.Tls12;
            string arch = (Environment.GetEnvironmentVariable("PROCESSOR_ARCHITEW6432") ?? Environment.GetEnvironmentVariable("PROCESSOR_ARCHITECTURE") ?? "").ToUpperInvariant();
            bool arm = arch == "ARM64";
            string url = null, sha = null, name = null;
            Log(t.Name + ": winget is not available, so the official installer is downloaded directly.");
            if (t.Exe == "node")
            {
                const string baseUrl = "https://nodejs.org/dist/latest-v22.x/";
                var m = Regex.Match(Fetch(baseUrl + "SHASUMS256.txt"), @"([0-9a-f]{64})\s+(node-v[\d.]+-" + (arm ? "arm64" : "x64") + @"\.msi)");
                if (!m.Success) throw new Exception("The Node.js download list could not be read.");
                sha = m.Groups[1].Value; name = m.Groups[2].Value; url = baseUrl + name;
            }
            else if (t.Exe == "gh")
            {
                var m = Regex.Match(Fetch("https://api.github.com/repos/cli/cli/releases/latest"), "\"browser_download_url\"\\s*:\\s*\"(https://github\\.com/cli/cli/releases/download/[^\"]+/(gh_[\\d.]+_windows_" + (arm ? "arm64" : "amd64") + "\\.msi))\"");
                if (!m.Success) throw new Exception("The GitHub CLI download list could not be read.");
                url = m.Groups[1].Value; name = m.Groups[2].Value;
            }
            else
            {
                var m = Regex.Match(Fetch("https://api.github.com/repos/git-for-windows/git/releases/latest"), "\"browser_download_url\"\\s*:\\s*\"(https://github\\.com/git-for-windows/git/releases/download/[^\"]+/(Git-[\\d.]+-" + (arm ? "arm64" : "64-bit") + "\\.exe))\"");
                if (!m.Success) throw new Exception("The Git download list could not be read.");
                url = m.Groups[1].Value; name = m.Groups[2].Value;
            }
            string file = Path.Combine(dir, name);
            Log("  Downloading " + url);
            Step("Downloading " + t.Name + "…", -1);
            using (var wc = new WebClient()) { wc.Headers[HttpRequestHeader.UserAgent] = "RepodeckSetup"; wc.DownloadFile(url, file); }
            if (sha != null)
            {
                using (var h = System.Security.Cryptography.SHA256.Create())
                using (var fs = File.OpenRead(file))
                {
                    string got = BitConverter.ToString(h.ComputeHash(fs)).Replace("-", "").ToLowerInvariant();
                    if (got != sha) throw new Exception("The downloaded file does not match its published checksum.");
                }
            }
            // Only run it if Windows confirms a valid publisher signature.
            string signer = SignerOf(file);
            if (signer == null) throw new Exception("The downloaded installer is not signed by a trusted publisher, so it was not run.");
            Log("  Signed by: " + signer);
            Step("Installing " + t.Name + "… Windows may ask for permission.", -1);
            int code;
            if (name.EndsWith(".msi", StringComparison.OrdinalIgnoreCase)) code = RunProcess(Path.Combine(Environment.SystemDirectory, "msiexec.exe"), "/i \"" + file + "\" /passive /norestart", false);
            else code = RunProcess(file, "/VERYSILENT /NORESTART /NOCANCEL /SP- /SUPPRESSMSGBOXES", false);
            RefreshPath();
            t.Found = Probe(t);
            if (t.Ok) { Log(t.Name + " " + t.Found + " installed."); return true; }
            Log(t.Name + " could not be installed (installer exit code " + code + "). Install it yourself, then choose Repair.");
            return false;
        }
        catch (Exception e)
        {
            Log(t.Name + " could not be installed: " + e.Message);
            Log("  Install it yourself, then run Setup again and choose Repair.");
            return false;
        }
        finally { DeleteDir(dir); }
    }

    static string Fetch(string url)
    {
        using (var wc = new WebClient())
        {
            wc.Headers[HttpRequestHeader.UserAgent] = "RepodeckSetup";
            wc.Encoding = Encoding.UTF8;
            return wc.DownloadString(url);
        }
    }

    /// The publisher of a signed file when Windows accepts its signature, else null.
    static string SignerOf(string file)
    {
        try
        {
            string ps = Path.Combine(Environment.SystemDirectory, "WindowsPowerShell", "v1.0", "powershell.exe");
            var psi = new ProcessStartInfo(ps, "-NoProfile -NonInteractive -Command \"$s = Get-AuthenticodeSignature -LiteralPath $env:REPODECK_CHECK_FILE; if ($s.Status -eq 'Valid') { 'OK ' + $s.SignerCertificate.Subject }\"") { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true };
            psi.EnvironmentVariables["REPODECK_CHECK_FILE"] = file;
            using (var p = Process.Start(psi))
            {
                string o = p.StandardOutput.ReadToEnd().Trim();
                p.WaitForExit(60000);
                if (!o.StartsWith("OK ")) return null;
                var m = Regex.Match(o, @"CN=(""[^""]+""|[^,]+)");
                return m.Success ? m.Groups[1].Value.Trim('"') : o.Substring(3);
            }
        }
        catch { return null; }
    }

    // ------------------------------------------------------------------ uninstall
    void Uninstall(bool wipeData)
    {
        Log("Removing Repodeck from " + installDir);
        Step("Closing Repodeck if it is running…", -1);
        StopRunningApp();
        Step("Removing files…", -1);
        foreach (var lnk in Portable ? new string[0] : new[] { Path.Combine(StartMenuDir(machine), "Repodeck.lnk"), Path.Combine(DesktopDir(machine), "Repodeck.lnk") })
        {
            try { if (File.Exists(lnk)) { File.Delete(lnk); Log("Removed " + lnk); } } catch (Exception e) { Log("Could not remove " + lnk + ": " + e.Message); }
        }
        if (!Portable)
        {
            using (var hive = Hive(machine))
            {
                try { hive.DeleteSubKeyTree(RegKey, false); } catch { }
                try { hive.DeleteSubKeyTree(@"Software\Classes\AppUserModelId\" + AppId, false); } catch { }
            }
            try { Registry.CurrentUser.DeleteSubKeyTree(@"Software\Classes\AppUserModelId\Repodeck.App", false); } catch { }
        }
        if (wipeData) { DeleteDir(dataDir); }
        // Remove everything we can now; this running Setup.exe (if it lives in the folder) is removed right after exit.
        if (Directory.Exists(installDir) && !IsInstalled()) Log("No Repodeck files found in " + installDir + "; the folder was left as it is.");
        else if (Directory.Exists(installDir))
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
    static RegistryKey Hive(bool forEveryone)
    {
        return forEveryone ? RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, RegistryView.Registry64) : RegistryKey.OpenBaseKey(RegistryHive.CurrentUser, RegistryView.Default);
    }
    static string ExistingInstallDir(bool forEveryone)
    {
        try
        {
            using (var hive = Hive(forEveryone))
            using (var k = hive.OpenSubKey(RegKey))
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
    static string StartMenuDir(bool forEveryone) { return Environment.GetFolderPath(forEveryone ? Environment.SpecialFolder.CommonPrograms : Environment.SpecialFolder.Programs); }
    static string DesktopDir(bool forEveryone) { return Environment.GetFolderPath(forEveryone ? Environment.SpecialFolder.CommonDesktopDirectory : Environment.SpecialFolder.DesktopDirectory); }

    /// Installing for everyone replaces a copy that was installed for this user only, so there are never two.
    void RemovePerUserCopy()
    {
        try
        {
            string dir = ExistingInstallDir(false);
            foreach (var lnk in new[] { Path.Combine(StartMenuDir(false), "Repodeck.lnk"), Path.Combine(DesktopDir(false), "Repodeck.lnk") })
            {
                try { if (File.Exists(lnk)) File.Delete(lnk); } catch { }
            }
            try { Registry.CurrentUser.DeleteSubKeyTree(RegKey, false); } catch { }
            try { Registry.CurrentUser.DeleteSubKeyTree(@"Software\Classes\AppUserModelId\" + AppId, false); } catch { }
            if (dir != null && File.Exists(Path.Combine(dir, "server", "main.js")) && !string.Equals(Path.GetFullPath(dir), Path.GetFullPath(installDir), StringComparison.OrdinalIgnoreCase))
            {
                DeleteDir(dir);
                Log("Removed the copy that was installed for one user from " + dir);
            }
        }
        catch (Exception e) { Log("Could not remove the per-user copy: " + e.Message); }
    }

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
        CloseAppWindows();
    }

    /// The app's windows are Repodeck.exe processes: they keep the program files open, so they must be gone before files are replaced.
    void CloseAppWindows()
    {
        foreach (var p in Process.GetProcessesByName("Repodeck"))
        {
            try
            {
                string file = p.MainModule.FileName;
                if (!file.StartsWith(installDir.TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)) continue;
                if (!p.HasExited && p.MainWindowHandle != IntPtr.Zero) { p.CloseMainWindow(); p.WaitForExit(2500); }
                if (!p.HasExited) { p.Kill(); p.WaitForExit(2500); }
                Log("Closed a Repodeck window.");
            }
            catch { /* already gone, or not ours */ }
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
            foreach (var lnk in new[] { Path.Combine(StartMenuDir(false), LegacyName + ".lnk"), Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), LegacyName + ".lnk") })
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
        try { TagShortcut(lnk); } catch { /* the shortcut still works without it */ }
    }

    // The same identity as the app window (installer/src/Launcher.cs, AppIdentity). With it on the shortcut,
    // Windows knows that the window belongs to this shortcut: "Pin to taskbar" pins it, and a click on a
    // notification starts it.
    const string AppId = "Repodeck.Desktop";

    [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IPropertyStore
    {
        int GetCount(out uint count);
        int GetAt(uint index, out PropertyKey key);
        int GetValue(ref PropertyKey key, out PropVariant value);
        int SetValue(ref PropertyKey key, ref PropVariant value);
        int Commit();
    }
    [StructLayout(LayoutKind.Sequential, Pack = 4)]
    struct PropertyKey { public Guid fmtid; public uint pid; }
    [StructLayout(LayoutKind.Sequential)]
    struct PropVariant { public ushort vt; public ushort r1, r2, r3; public IntPtr p; public IntPtr p2; }
    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    static extern int SHGetPropertyStoreFromParsingName(string path, IntPtr bindCtx, int flags, ref Guid iid, out IPropertyStore store);

    [DllImport("shell32.dll")]
    static extern void SHChangeNotify(int eventId, int flags, IntPtr item1, IntPtr item2);

    static void TagShortcut(string lnk)
    {
        Guid iid = typeof(IPropertyStore).GUID;
        IPropertyStore store;
        if (SHGetPropertyStoreFromParsingName(lnk, IntPtr.Zero, 2 /* read and write */, ref iid, out store) != 0 || store == null) return;
        var key = new PropertyKey { fmtid = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"), pid = 5 }; // System.AppUserModel.ID
        var v = new PropVariant { vt = 31, p = Marshal.StringToCoTaskMemUni(AppId) };
        try { store.SetValue(ref key, ref v); store.Commit(); }
        finally { Marshal.FreeCoTaskMem(v.p); Marshal.ReleaseComObject(store); }
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
        parts.Add(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "Git", "cmd"));
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
            if (x == "datadir" && i + 1 < args.Length) { SetupForm.DataDirOverride = Path.GetFullPath(args[++i]); continue; }
            if (x == "snapshot" && i + 1 < args.Length) { SetupForm.Snapshot = args[++i]; continue; }
            if (x == "page" && i + 1 < args.Length) { SetupForm.SnapshotPage = args[++i].ToLowerInvariant(); continue; }
            if (x == "run" && i + 1 < args.Length) { string r = args[++i].ToLowerInvariant(); if (r == "install" || r == "repair" || r == "uninstall") SetupForm.AutoRun = r; continue; }
            if (x == "portable") SetupForm.Portable = true;
            if (x == "allusers") SetupForm.AllUsersArg = true;
            if (x == "desktop") SetupForm.DesktopArg = true;
            if (x == "notools") SetupForm.NoToolsArg = true;
            if (x == "wipedata") SetupForm.WipeArg = true;
            if (x == "uninstall" || x == "install" || x == "repair") action = x;
            if (x == "quiet" || x == "silent") quiet = true;
        }
        if (quiet && action == "") action = SetupForm.AutoRun ?? "install";
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        var form = new SetupForm(action, quiet);
        if (quiet) { form.WindowState = FormWindowState.Minimized; form.ShowInTaskbar = false; }
        Application.Run(form);
        return form.ExitCode;
    }
}
