// Repodeck.exe: starts the app without a console window (or brings up the running copy).
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Windows.Forms;

static class Launcher
{
    [STAThread]
    static int Main(string[] args)
    {
        string root = AppDomain.CurrentDomain.BaseDirectory;
        string main = Path.Combine(root, "server", "main.js");
        if (!File.Exists(main))
        {
            MessageBox.Show("Repodeck is not installed correctly: server\\main.js is missing next to Repodeck.exe.\n\nRun Setup and choose Repair.", "Repodeck", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
        string path = FreshPath();
        string node = FindNode(path);
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
