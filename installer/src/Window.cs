// "Repodeck.exe --window <url> [--account <login>]": the app's own window.
// A plain Windows window that shows the local UI through WebView2 (the web engine that ships with
// Windows 11 and Microsoft 365). No browser profile, no browser buttons: just the app.
// Exit code 3 means "WebView2 is not available here"; the server then falls back to an Edge app window.
using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

static class WindowHost
{
    [DllImport("shell32.dll", CharSet = CharSet.Unicode)] static extern int SetCurrentProcessExplicitAppUserModelID(string id);

    [MethodImpl(MethodImplOptions.NoInlining)]
    public static int Run(string url, string account)
    {
        if (url == null || !Regex.IsMatch(url, @"^http://127\.0\.0\.1:\d{2,5}/")) return 2; // only ever the local server
        string version = null;
        try { version = CoreWebView2Environment.GetAvailableBrowserVersionString(); } catch { }
        if (string.IsNullOrEmpty(version)) return 3;
        if (!AppIdentity.Packaged) SetCurrentProcessExplicitAppUserModelID(AppIdentity.Id);
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        var w = new MainWindow(url, account);
        Application.Run(w);
        return w.Failed ? 3 : 0;
    }

    public static string DataDir()
    {
        string d = Environment.GetEnvironmentVariable("REPODECK_DATA");
        if (string.IsNullOrEmpty(d)) d = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Repodeck");
        return d;
    }
}

sealed class MainWindow : Form
{
    [DllImport("dwmapi.dll")] static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int value, int size);
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hwnd, int cmd);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hwnd);
    [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);

    static readonly Color Ink = Color.FromArgb(0x0d, 0x10, 0x14); // the app's dark background, shown until the page has drawn

    readonly string url;
    readonly string origin;
    readonly string boundsFile;
    readonly WebView2 web = new WebView2();
    public bool Failed;
    bool shown;
    bool toTray = true;   // the page says otherwise when the setting is off
    bool quitting;
    bool byButton;        // the close request came from the title bar's close button or Alt+F4
    NotifyIcon tray;
    readonly string account;

    public MainWindow(string url, string account)
    {
        this.url = url;
        this.account = account;
        origin = Regex.Match(url, @"^http://127\.0\.0\.1:\d+").Value;
        string who = !string.IsNullOrEmpty(account) && Regex.IsMatch(account, "^[A-Za-z0-9-]+$") ? account : "default";
        boundsFile = Path.Combine(WindowHost.DataDir(), "window-" + who + ".txt");

        Text = "Repodeck";
        // The .ico next to the exe has every size, so the taskbar gets a sharp picture at any scaling.
        try
        {
            string ico = Path.Combine(Path.GetDirectoryName(Application.ExecutablePath), "repodeck.ico");
            Icon = File.Exists(ico) ? new Icon(ico) : Icon.ExtractAssociatedIcon(Application.ExecutablePath);
        }
        catch { }
        BackColor = Ink;
        MinimumSize = new Size(820, 560);
        StartPosition = FormStartPosition.Manual;
        RestoreBoundsFromDisk();

        web.Dock = DockStyle.Fill;
        web.DefaultBackgroundColor = Ink;
        Controls.Add(web);

        Load += async (s, e) => { await Start(); };
        FormClosing += (s, e) =>
        {
            SaveBounds();
            // The close button hides the window; the app keeps running next to the clock. Quit, Windows
            // shutting down, or a window that never loaded close it for real.
            if (toTray && shown && !quitting && byButton) { e.Cancel = true; HideToTray(); return; }
            if (tray != null) { tray.Visible = false; tray.Dispose(); tray = null; }
        };
    }

    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        TitleBar(true, Ink);
        // "Pin to taskbar" pins Repodeck.exe itself, not this window's command line.
        try { if (!AppIdentity.Packaged) Brand.Apply(Handle, Application.ExecutablePath, false); } catch { }
    }

    async Task Start()
    {
        try
        {
            // The web engine keeps its cache here. It is not a browser profile: no sign-in, sync or extensions.
            string store = Path.Combine(WindowHost.DataDir(), "webview");
            var env = await CoreWebView2Environment.CreateAsync(null, store, null);
            await web.EnsureCoreWebView2Async(env);
            var core = web.CoreWebView2;
            var st = core.Settings;
            st.AreDevToolsEnabled = Environment.GetEnvironmentVariable("REPODECK_DEVTOOLS") == "1";
            st.AreBrowserAcceleratorKeysEnabled = st.AreDevToolsEnabled; // no F5, Ctrl+P print, Ctrl+F find bar: the app has its own keys
            st.IsStatusBarEnabled = false;
            st.IsPasswordAutosaveEnabled = false;
            st.IsGeneralAutofillEnabled = false;
            st.IsSwipeNavigationEnabled = false;
            st.IsBuiltInErrorPageEnabled = false;

            core.DocumentTitleChanged += (s, e) => { string t = core.DocumentTitle; if (!string.IsNullOrEmpty(t) && !t.StartsWith("127.0.0.1")) Text = t; };
            // Links to other sites open in the default browser; this window only ever shows the app.
            core.NewWindowRequested += (s, e) => { e.Handled = true; OpenExternal(e.Uri); };
            core.NavigationStarting += (s, e) => { if (!IsOurs(e.Uri)) { e.Cancel = true; OpenExternal(e.Uri); } };
            core.WebMessageReceived += (s, e) => { string m = null; try { m = e.TryGetWebMessageAsString(); } catch { } if (m != null && IsOurs(e.Source)) OnMessage(m); };
            // The browser's own menu (Back, Reload, Save as, Inspect) has no place here. Keep it for text: copy, paste.
            core.ContextMenuRequested += (s, e) => { if (!e.ContextMenuTarget.IsEditable && !e.ContextMenuTarget.HasSelection) e.Handled = true; };
            core.PermissionRequested += (s, e) => { e.State = e.PermissionKind == CoreWebView2PermissionKind.ClipboardRead && IsOurs(e.Uri) ? CoreWebView2PermissionState.Allow : CoreWebView2PermissionState.Deny; };
            core.ProcessFailed += (s, e) => { if (e.ProcessFailedKind == CoreWebView2ProcessFailedKind.RenderProcessExited) { try { core.Reload(); } catch { } } };
            core.Navigate(url);
            shown = true;
        }
        catch (Exception)
        {
            if (!shown) { Failed = true; Close(); }
        }
    }

    bool IsOurs(string uri) { return uri != null && (uri == origin || uri.StartsWith(origin + "/")); }

    static void OpenExternal(string uri)
    {
        Uri u;
        if (!Uri.TryCreate(uri, UriKind.Absolute, out u) || (u.Scheme != Uri.UriSchemeHttps && u.Scheme != Uri.UriSchemeHttp)) return;
        try { Process.Start(new ProcessStartInfo(u.AbsoluteUri) { UseShellExecute = true }); } catch { }
    }

    // Messages from the page: "theme dark|light r g b", "focus", "close", "tray on|off".
    void OnMessage(string m)
    {
        if (m == "close") { quitting = true; Close(); return; }
        if (m == "tray on" || m == "tray off") { toTray = m == "tray on"; SyncTray(); return; }
        if (m == "focus") { BringForward(); return; }
        var t = Regex.Match(m, @"^theme (dark|light) (\d{1,3}) (\d{1,3}) (\d{1,3})$");
        if (t.Success)
        {
            Color c = Color.FromArgb(Math.Min(255, int.Parse(t.Groups[2].Value)), Math.Min(255, int.Parse(t.Groups[3].Value)), Math.Min(255, int.Parse(t.Groups[4].Value)));
            TitleBar(t.Groups[1].Value == "dark", c);
        }
    }

    // The title bar takes the colour of the app's top bar, so the window reads as one piece.
    void TitleBar(bool dark, Color c)
    {
        try
        {
            int on = dark ? 1 : 0;
            DwmSetWindowAttribute(Handle, 20, ref on, 4);          // dark window frame (Windows 10 2004 and later)
            int rgb = c.R | (c.G << 8) | (c.B << 16);
            DwmSetWindowAttribute(Handle, 35, ref rgb, 4);         // caption colour (Windows 11)
            DwmSetWindowAttribute(Handle, 34, ref rgb, 4);         // border colour (Windows 11)
            int text = dark ? 0x00E6E6E6 : 0x00202020;
            DwmSetWindowAttribute(Handle, 36, ref text, 4);        // caption text (Windows 11)
        }
        catch { }
    }

    void BringForward()
    {
        if (!Visible) Show();
        if (IsIconic(Handle)) ShowWindow(Handle, 9); // restore
        // Windows only lets a process take the foreground after input; a tap of Alt counts.
        keybd_event(0x12, 0, 0, UIntPtr.Zero);
        keybd_event(0x12, 0, 2, UIntPtr.Zero);
        SetForegroundWindow(Handle);
        Activate();
    }

    protected override void WndProc(ref Message m)
    {
        // Only the close button and Alt+F4 hide to the tray. Task Manager, Setup and Windows shutting
        // down send a bare close request, and that one always closes for real.
        if (m.Msg == 0x0112 && ((int)m.WParam.ToInt64() & 0xFFF0) == 0xF060)
        {
            byButton = true;
            try { base.WndProc(ref m); } finally { byButton = false; }
            return;
        }
        base.WndProc(ref m);
    }

    // ---------- notification area ----------
    void SyncTray()
    {
        if (!toTray)
        {
            if (tray != null && Visible) { tray.Visible = false; tray.Dispose(); tray = null; }
            return;
        }
        if (tray != null) return;
        var menu = new ContextMenuStrip();
        menu.Items.Add("Open Repodeck", null, (s, e) => BringForward());
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("Quit", null, (s, e) => { quitting = true; Close(); });
        string tip = string.IsNullOrEmpty(account) ? "Repodeck" : "Repodeck · " + account;
        tray = new NotifyIcon { Icon = Icon, Text = tip.Length > 60 ? tip.Substring(0, 60) : tip, ContextMenuStrip = menu, Visible = true };
        tray.MouseClick += (s, e) => { if (e.Button == MouseButtons.Left) BringForward(); };
    }

    void HideToTray()
    {
        SyncTray();
        Hide();
        // Say once where the window went.
        try
        {
            string seen = Path.Combine(WindowHost.DataDir(), "tray-hint-shown.txt");
            if (!File.Exists(seen))
            {
                File.WriteAllText(seen, "1");
                tray.ShowBalloonTip(6000, "Repodeck is still running", "Click this icon to open it again. Right-click it to quit. You can change this in Settings.", ToolTipIcon.None);
            }
        }
        catch { }
    }

    // ---------- remembered size and position ----------
    void RestoreBoundsFromDisk()
    {
        Rectangle area = Screen.PrimaryScreen.WorkingArea;
        Size size = new Size(Math.Min(1440, area.Width - 80), Math.Min(900, area.Height - 60));
        Rectangle r = new Rectangle(area.X + (area.Width - size.Width) / 2, area.Y + (area.Height - size.Height) / 2, size.Width, size.Height);
        bool max = false;
        try
        {
            string[] p = File.ReadAllText(boundsFile).Trim().Split(',');
            if (p.Length == 5)
            {
                var saved = new Rectangle(int.Parse(p[0]), int.Parse(p[1]), int.Parse(p[2]), int.Parse(p[3]));
                // only if it is still on a connected screen
                foreach (Screen s in Screen.AllScreens)
                {
                    Rectangle seen = Rectangle.Intersect(s.WorkingArea, saved);
                    if (seen.Width >= 200 && seen.Height >= 120 && saved.Width >= 820 && saved.Height >= 560) { r = saved; max = p[4] == "1"; break; }
                }
            }
        }
        catch { }
        Bounds = r;
        if (max) WindowState = FormWindowState.Maximized;
    }

    void SaveBounds()
    {
        try
        {
            if (WindowState == FormWindowState.Minimized && RestoreBounds.Width == 0) return;
            Rectangle r = WindowState == FormWindowState.Normal ? Bounds : RestoreBounds;
            Directory.CreateDirectory(Path.GetDirectoryName(boundsFile));
            File.WriteAllText(boundsFile, r.X + "," + r.Y + "," + r.Width + "," + r.Height + "," + (WindowState == FormWindowState.Maximized ? "1" : "0"));
        }
        catch { }
    }
}
