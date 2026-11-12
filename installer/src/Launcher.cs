// Repodeck.exe: starts the app without a console window (or brings up the running copy).
// The same exe is the app window itself when the server starts it with --window (see Window.cs).
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

// How Windows knows the app: taskbar grouping, pinning and notifications all hang on this name.
// An installed copy and a build in a source checkout use different names, so that trying a development
// build can never change what the installed app's taskbar button or notifications start.
static class AppIdentity
{
    public const string Installed = "Repodeck.Desktop";

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    static extern int GetCurrentPackageFullName(ref int length, System.Text.StringBuilder name);
    /// True when running as a Microsoft Store package: Windows then supplies the taskbar identity itself.
    public static bool Packaged
    {
        get { try { int n = 0; return GetCurrentPackageFullName(ref n, null) == 122; } catch { return false; } }
    }
    public static string Id
    {
        get { return File.Exists(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "server", "main.js")) ? Installed : "Repodeck.Dev"; }
    }
}

static class Launcher
{
    [STAThread]
    static int Main(string[] args)
    {
        if (args.Length > 0 && args[0] == "--brand") return Brand.Run();
        if (args.Length > 1 && args[0] == "--window")
        {
            // A missing WebView2 file or runtime must not show a crash dialog: report it and let the server fall back.
            try { return WindowHost.Run(args[1], args.Length > 3 && args[2] == "--account" ? args[3] : null); }
            catch (Exception) { return 3; }
        }
        // Started by the user: the window this leads to (new or already open) may come to the front.
        try { AllowSetForegroundWindow(-1); } catch { }
        string root = AppDomain.CurrentDomain.BaseDirectory;
        string main = Path.Combine(root, "server", "main.js");
        if (!File.Exists(main))
        {
            // A build inside a source checkout (dist\Repodeck.exe): the server is one folder up.
            string up = Path.GetFullPath(Path.Combine(root, ".."));
            if (File.Exists(Path.Combine(up, "server", "main.js"))) { root = up; main = Path.Combine(up, "server", "main.js"); }
        }
        if (!File.Exists(main))
        {
            MessageBox.Show("Repodeck is not installed correctly: server\\main.js is missing next to Repodeck.exe.\n\nRun Setup and choose Repair.", "Repodeck", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
        string path = FreshPath();
        string own = Path.Combine(root, "node", "node.exe"); // the Microsoft Store package brings its own
        string node = File.Exists(own) ? own : FindNode(path);
        if (node == null)
        {
            MessageBox.Show("Node.js was not found.\n\nRun Repodeck Setup and choose Repair to install it, or install Node.js 20 or newer yourself.", "Repodeck", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            return 1;
        }
        try
        {
            var psi = new ProcessStartInfo(node, "\"" + main + "\"" + (args.Length > 0 ? " " + string.Join(" ", args) : ""));
            psi.WorkingDirectory = root;
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            psi.EnvironmentVariables["PATH"] = path;
            Process.Start(psi);
            return 0;
        }
        catch (Exception e)
        {
            MessageBox.Show("Could not start Repodeck:\n" + e.Message, "Repodeck", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
    }

    [DllImport("user32.dll")] static extern bool AllowSetForegroundWindow(int pid);

    // A shortcut's process can have a PATH from before Git / Node were installed: rebuild it from the registry.
    static string FreshPath()
    {
        var parts = new List<string>();
        foreach (var target in new[] { EnvironmentVariableTarget.Machine, EnvironmentVariableTarget.User, EnvironmentVariableTarget.Process })
        {
            string p = Environment.GetEnvironmentVariable("PATH", target);
            if (!string.IsNullOrEmpty(p)) parts.Add(Environment.ExpandEnvironmentVariables(p));
        }
        return string.Join(";", parts.ToArray());
    }

    static string FindNode(string path)
    {
        var dirs = new List<string>(path.Split(new[] { ';' }, StringSplitOptions.RemoveEmptyEntries));
        dirs.Add(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "nodejs"));
        dirs.Add(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "nodejs"));
        string nvm = Environment.GetEnvironmentVariable("NVM_SYMLINK");
        if (!string.IsNullOrEmpty(nvm)) dirs.Add(nvm);
        foreach (string d in dirs)
        {
            try
            {
                string f = Path.Combine(d.Trim().Trim('"'), "node.exe");
                if (File.Exists(f)) return f;
            }
            catch { }
        }
        return null;
    }
}

// "Repodeck.exe --brand": the app window is drawn by Microsoft Edge in app mode, so Windows would
// list it as "Microsoft Edge" on the taskbar and pin Edge instead of Repodeck. This gives the window
// Repodeck's own identity: its name in the taskbar menu, and Repodeck.exe as what gets pinned.
static class Brand
{
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

    delegate bool EnumProc(IntPtr hwnd, IntPtr lParam);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd, StringBuilder sb, int max);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd, StringBuilder sb, int max);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("shell32.dll")] static extern int SHGetPropertyStoreForWindow(IntPtr hwnd, ref Guid iid, out IPropertyStore store);

    static readonly Guid AppUserModel = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3");

    public static int Run()
    {
        string exe = Process.GetCurrentProcess().MainModule.FileName;
        var done = new HashSet<IntPtr>();
        DateTime stop = DateTime.UtcNow.AddSeconds(45);
        DateTime? first = null;
        while (DateTime.UtcNow < stop && (first == null || DateTime.UtcNow < first.Value.AddSeconds(6)))
        {
            foreach (IntPtr h in Find())
            {
                if (done.Contains(h)) continue;
                if (Apply(h, exe)) { done.Add(h); if (first == null) first = DateTime.UtcNow; }
            }
            Thread.Sleep(350);
        }
        return done.Count > 0 ? 0 : 2;
    }

    // Edge app windows whose title is the one the Repodeck page sets.
    static List<IntPtr> Find()
    {
        var found = new List<IntPtr>();
        EnumWindows(delegate (IntPtr h, IntPtr l)
        {
            if (!IsWindowVisible(h)) return true;
            var sb = new StringBuilder(256);
            GetClassName(h, sb, sb.Capacity);
            if (sb.ToString() != "Chrome_WidgetWin_1") return true;
            sb.Clear();
            GetWindowText(h, sb, sb.Capacity);
            string t = sb.ToString();
            if (t != "Repodeck" && !t.StartsWith("Repodeck · ")) return true;
            uint pid;
            GetWindowThreadProcessId(h, out pid);
            try { if (Process.GetProcessById((int)pid).ProcessName.ToLowerInvariant() != "msedge") return true; } catch { return true; }
            found.Add(h);
            return true;
        }, IntPtr.Zero);
        return found;
    }

    public static bool Apply(IntPtr hwnd, string exe) { return Apply(hwnd, exe, true); }

    /// withIcon = false leaves the taskbar picture to the window's own icon. Windows caches a picture
    /// given by file path and keeps showing an old one after an update; the window's icon is always current.
    public static bool Apply(IntPtr hwnd, string exe, bool withIcon)
    {
        try
        {
            Guid iid = typeof(IPropertyStore).GUID;
            IPropertyStore store;
            if (SHGetPropertyStoreForWindow(hwnd, ref iid, out store) != 0 || store == null) return false;
            bool ok = Set(store, 5, AppIdentity.Id)                     // System.AppUserModel.ID
                & Set(store, 2, "\"" + exe + "\"")            // RelaunchCommand
                & Set(store, 4, "Repodeck")                  // RelaunchDisplayNameResource
                & (withIcon ? Set(store, 3, exe + ",0") : true); // RelaunchIconResource
            store.Commit();
            Marshal.ReleaseComObject(store);
            return ok;
        }
        catch { return false; }
    }

    static bool Set(IPropertyStore store, uint pid, string value)
    {
        var key = new PropertyKey { fmtid = AppUserModel, pid = pid };
        var v = new PropVariant { vt = 31, p = Marshal.StringToCoTaskMemUni(value) }; // VT_LPWSTR
        try { return store.SetValue(ref key, ref v) == 0; }
        finally { Marshal.FreeCoTaskMem(v.p); }
    }
}
