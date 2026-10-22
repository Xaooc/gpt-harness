// LunaWidget — tray icon + flyout (or pinned desktop widget) for the Luna / Codex orchestration.
// Data: `node %USERPROFILE%\.claude\scripts\luna-overview.mjs` (one JSON snapshot), polled every 5 s while visible,
// every 30 s otherwise. Built with the C# 5 compiler that ships with .NET Framework 4.x (see build-widget.cmd).
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Text;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Win32;

namespace LunaWidget
{
    static class Program
    {
        [DllImport("user32.dll")] static extern bool SetProcessDPIAware();

        [STAThread]
        static void Main(string[] args)
        {
            // --render <png>: poll once, draw the panel into an image and exit (design checks, docs).
            if (args.Length == 2 && args[0] == "--render")
            {
                try { SetProcessDPIAware(); } catch { }
                var form = new PanelForm(null);
                form.SetData(Collector.Poll());
                using (var bmp = new Bitmap(form.Width, form.Height))
                {
                    form.DrawToBitmap(bmp, new Rectangle(0, 0, form.Width, form.Height));
                    bmp.Save(args[1], System.Drawing.Imaging.ImageFormat.Png);
                }
                return;
            }
            bool created;
            using (var mutex = new Mutex(true, "LunaWidget.SingleInstance", out created))
            {
                if (!created) return;
                try { SetProcessDPIAware(); } catch { }
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                Application.Run(new TrayApp());
            }
        }
    }

    // ---- Data model (a thin view over the collector JSON) ----------------------------------------------------------
    class Alert { public bool Error; public string Text; }

    class JobView
    {
        public string Name, Model, State, Activity; public bool ActivityRaw;
        public double AgeS; public double IdleS = -1; public string Owner, Dir;
    }

    class SessionView
    {
        public string Id, Name, ClaudeText; public int ClaudeState; // 0 unknown, 1 thinking, 2 tool, 3 idle
        public double ClaudeSinceS; public List<JobView> Jobs = new List<JobView>();
        public List<string> Agents = new List<string>();
    }

    class Limit { public string Label; public double Pct; public string Resets; }

    class Snapshot
    {
        public bool Ok; public string Error;
        public double FreeMb, TotalMb;
        public bool DaemonRunning, DaemonHealthy = true, AppServerDown; public int DaemonRunningJobs, DaemonQueued, DaemonMax;
        public double DaemonUptimeS;
        public List<Limit> Limits = new List<Limit>();
        public bool CodexReached;
        public List<SessionView> Sessions = new List<SessionView>();
        public List<Alert> Alerts = new List<Alert>();
        public int Running, Waiting;
        public DateTime At = DateTime.Now;
    }

    static class Collector
    {
        static string NodePath()
        {
            foreach (var dir in (Environment.GetEnvironmentVariable("PATH") ?? "").Split(';'))
            {
                try { var p = Path.Combine(dir.Trim(), "node.exe"); if (File.Exists(p)) return p; } catch { }
            }
            var pf = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
            return Path.Combine(pf, "nodejs", "node.exe");
        }

        public static Snapshot Poll()
        {
            var snap = new Snapshot();
            try
            {
                var home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
                var script = Path.Combine(home, ".claude", "scripts", "luna-overview.mjs");
                if (!File.Exists(script)) { snap.Error = "нет luna-overview.mjs"; return snap; }
                var psi = new ProcessStartInfo(NodePath(), "\"" + script + "\"")
                {
                    UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true,
                    RedirectStandardError = true, StandardOutputEncoding = Encoding.UTF8
                };
                string json;
                using (var p = Process.Start(psi))
                {
                    var read = p.StandardOutput.ReadToEndAsync();
                    if (!p.WaitForExit(15000)) { try { p.Kill(); } catch { } snap.Error = "сборщик не ответил"; return snap; }
                    json = read.Result;
                }
                Parse(json, snap);
                snap.Ok = true;
            }
            catch (Exception ex) { snap.Error = ex.Message.Length > 80 ? ex.Message.Substring(0, 80) : ex.Message; }
            Analyse(snap);
            return snap;
        }

        static Dictionary<string, object> Obj(object o) { return o as Dictionary<string, object>; }
        static IEnumerable<Dictionary<string, object>> Arr(object o)
        {
            var a = o as IEnumerable; if (a == null || o is string) yield break;
            foreach (var x in a) { var d = x as Dictionary<string, object>; if (d != null) yield return d; }
        }
        static string Str(Dictionary<string, object> d, string k) { object v; return d != null && d.TryGetValue(k, out v) && v != null ? Convert.ToString(v) : ""; }
        static double Num(Dictionary<string, object> d, string k, double def)
        {
            object v; if (d == null || !d.TryGetValue(k, out v) || v == null) return def;
            try { return Convert.ToDouble(v, System.Globalization.CultureInfo.InvariantCulture); } catch { return def; }
        }
        static bool Bool(Dictionary<string, object> d, string k, bool def) { object v; return d != null && d.TryGetValue(k, out v) && v is bool ? (bool)v : def; }

        static string WindowName(string kind, double mins)
        {
            if (kind == "five_hour" || mins == 300) return "5 часов";
            if (kind == "seven_day" || mins == 10080) return "неделя";
            if (mins > 0) return mins >= 1440 ? Math.Round(mins / 1440) + " д" : Math.Round(mins / 60) + " ч";
            return kind;
        }

        static string ResetsIn(string iso)
        {
            DateTime t; if (string.IsNullOrEmpty(iso) || !DateTime.TryParse(iso, null, System.Globalization.DateTimeStyles.RoundtripKind, out t)) return null;
            return "сброс через " + Fmt.Duration((t.ToUniversalTime() - DateTime.UtcNow).TotalSeconds);
        }

        static void Parse(string json, Snapshot s)
        {
            var root = Obj(new JavaScriptSerializer { MaxJsonLength = 16 * 1024 * 1024 }.DeserializeObject(json));
            var ram = Obj(root["ram"]);
            s.FreeMb = Num(ram, "freeMb", 0); s.TotalMb = Num(ram, "totalMb", 1);
            var dm = Obj(root.ContainsKey("daemon") ? root["daemon"] : null);
            s.DaemonRunning = Bool(dm, "running", false);
            s.DaemonHealthy = Bool(dm, "healthy", true);
            s.AppServerDown = Str(dm, "appServer") == "down";
            s.DaemonRunningJobs = (int)Num(dm, "runningJobs", 0); s.DaemonQueued = (int)Num(dm, "queuedJobs", 0);
            s.DaemonMax = (int)Num(dm, "max", 0); s.DaemonUptimeS = Num(dm, "uptimeS", 0);

            // Claude limits travel inside session heartbeats: take the freshest beat that carries them.
            var beats = Arr(root.ContainsKey("sessions") ? root["sessions"] : null).ToList();
            var withLimits = beats.Where(b => b.ContainsKey("limits")).OrderByDescending(b => Num(b, "updatedAt", 0)).FirstOrDefault();
            if (withLimits != null)
                foreach (var l in Arr(withLimits["limits"]))
                {
                    if (Str(l, "kind") == "spend_limit") continue;
                    s.Limits.Add(new Limit { Label = "Claude · " + WindowName(Str(l, "kind"), 0), Pct = Num(l, "percentUsed", 0), Resets = ResetsIn(Str(l, "resetsAt")) });
                }
            var cl = Obj(root.ContainsKey("codexLimits") ? root["codexLimits"] : null);
            if (cl != null)
            {
                s.CodexReached = Str(cl, "reached") != "";
                foreach (var key in new[] { "primary", "secondary" })
                {
                    var w = Obj(cl.ContainsKey(key) ? cl[key] : null); if (w == null) continue;
                    s.Limits.Add(new Limit { Label = "Codex · " + WindowName("", Num(w, "windowMins", 0)), Pct = Num(w, "usedPercent", 0), Resets = ResetsIn(Str(w, "resetsAt")) });
                }
            }

            var jobs = new List<JobView>();
            foreach (var j in Arr(root["jobs"]))
            {
                var jv = new JobView
                {
                    Name = Regex.Replace(Path.GetFileName(Str(j, "out").Replace('\\', '/')), @"\.out\.md$|\.md$", ""),
                    Model = Regex.IsMatch(Str(j, "model"), "sol", RegexOptions.IgnoreCase) ? "Sol" : Regex.IsMatch(Str(j, "model"), "luna", RegexOptions.IgnoreCase) ? "Luna" : Str(j, "model"),
                    State = Str(j, "state"), AgeS = Num(j, "ageS", 0), IdleS = Num(j, "idleS", -1), Owner = Str(j, "owner"), Dir = Str(j, "dir")
                };
                var act = Obj(j.ContainsKey("activity") ? j["activity"] : null);
                if (act != null)
                {
                    var kind = Str(act, "kind"); var text = Str(act, "text");
                    if (kind == "command") { bool raw; jv.Activity = Describe(text, out raw); jv.ActivityRaw = raw; }
                    else if (kind == "thinking") jv.Activity = "думает";
                    else if (kind == "editing") jv.Activity = text != "" ? "правит: " + text : "правит файлы";
                    else if (kind == "writing") jv.Activity = "пишет ответ";
                    else if (kind == "starting") jv.Activity = "запускается";
                }
                jobs.Add(jv);
            }
            s.Running = jobs.Count(x => x.State == "running"); s.Waiting = jobs.Count - s.Running;

            var ids = beats.Select(b => Str(b, "sessionId")).Concat(jobs.Select(x => x.Owner)).Where(x => x != "").Distinct().ToList();
            foreach (var id in ids)
            {
                var b = beats.FirstOrDefault(x => Str(x, "sessionId") == id);
                var sv = new SessionView { Id = id, Jobs = jobs.Where(x => x.Owner == id).ToList() };
                double now = (DateTime.UtcNow - new DateTime(1970, 1, 1)).TotalMilliseconds;
                if (b != null && now - Num(b, "updatedAt", 0) < 15 * 60 * 1000)
                {
                    sv.Name = Str(b, "name");
                    var st = Str(b, "state"); var tool = Obj(b.ContainsKey("tool") ? b["tool"] : null);
                    bool fresh = now - Num(b, "updatedAt", 0) < 60000;
                    if (!fresh) { sv.ClaudeState = 3; sv.ClaudeText = "сессия неактивна"; }
                    else if (st == "tool" && tool != null)
                    {
                        sv.ClaudeState = 2; var det = Str(tool, "detail");
                        var toolName = Str(tool, "name");
                        if ((toolName == "Bash" || toolName == "PowerShell") && det != "") { bool raw; var said = Describe(det, out raw); sv.ClaudeText = raw ? "выполняет: " + said : said; }
                        else sv.ClaudeText = toolName + (det != "" ? ": " + det : "");
                        sv.ClaudeSinceS = (now - Num(tool, "since", now)) / 1000;
                    }
                    else if (st == "thinking") { sv.ClaudeState = 1; sv.ClaudeText = "думает"; sv.ClaudeSinceS = (now - Num(b, "turnSince", now)) / 1000; }
                    else { sv.ClaudeState = 3; sv.ClaudeText = "ждёт вас"; sv.ClaudeSinceS = (now - Num(b, "idleSince", now)) / 1000; }
                    foreach (var a in Arr(b.ContainsKey("agents") ? b["agents"] : null)) sv.Agents.Add(Str(a, "description"));
                }
                else { sv.ClaudeText = "нет данных о Claude"; }
                if (string.IsNullOrEmpty(sv.Name)) sv.Name = ProjectOf(sv.Jobs);
                if (string.IsNullOrEmpty(sv.Name)) sv.Name = "Сессия без проекта";
                s.Sessions.Add(sv);
            }
            // Busy sessions first: Claude working, then sessions with Codex jobs, then the rest.
            s.Sessions = s.Sessions.OrderBy(x => x.ClaudeState == 1 || x.ClaudeState == 2 ? 0 : x.Jobs.Count > 0 ? 1 : 2).ThenBy(x => x.Name).ToList();
        }

        static string ProjectOf(List<JobView> jobs)
        {
            var dirs = jobs.Select(j => Regex.Replace(Regex.Replace((j.Dir ?? "").Replace('\\', '/').TrimEnd('/'), @"/\.claude/worktrees/[^/]+$", ""), @"/\.worktrees/[^/]+$", ""))
                .Where(d => d != "").ToList();
            if (dirs.Count == 0) return "";
            Func<string, string> baseName = d => d.Split('/').Where(p => p != "").LastOrDefault() ?? "";
            Func<string, string> parent = d => d.Contains('/') ? d.Substring(0, d.LastIndexOf('/')) : "";
            if (dirs.All(d => d == dirs[0])) return baseName(dirs[0]);
            if (dirs.All(d => parent(d) == parent(dirs[0]))) return baseName(parent(dirs[0]));
            return baseName(dirs[0]);
        }

        // A shell command as a person would describe it (same rules as the Luna pane).
        static string Describe(string raw, out bool isRaw)
        {
            isRaw = false;
            var cmd = Regex.Replace(raw.Trim(), @"^\S*?(?:sh|bash|pwsh|powershell)(?:\.exe)?\s+(?:-\w+\s+)*", "", RegexOptions.IgnoreCase).Trim('"', '\'');
            cmd = Regex.Replace(cmd, @"^(?:cd\s+\S+\s*&&\s*)+", "").Trim();
            if (Regex.IsMatch(cmd, @"\b(pytest|vitest|jest|mocha|playwright test|cargo test|go test|node --test)\b|\b(npm|pnpm|yarn|bun) (run )?test")) return "запускает тесты";
            if (Regex.IsMatch(cmd, @"\b(tsc|eslint|ruff|mypy|pyright|cargo (check|clippy)|biome)\b")) return "проверяет типы и стиль";
            if (Regex.IsMatch(cmd, @"\b(npm|pnpm|yarn|bun) (install|ci|i|add)\b|\buv (sync|pip)\b|\bpip install\b")) return "ставит зависимости";
            if (Regex.IsMatch(cmd, @"\b(vite build|webpack|cargo build|next build)\b|\b(npm|pnpm|yarn) (run )?build\b")) return "собирает проект";
            if (Regex.IsMatch(cmd, @"^(rg|grep|fd|find)\b")) return "ищет в коде";
            if (Regex.IsMatch(cmd, @"^(cat|sed -n|head|tail|wc|ls|type|nl)\b")) return "читает файлы";
            var g = Regex.Match(cmd, @"^git\s+(\S+)"); if (g.Success) return "git " + g.Groups[1].Value;
            isRaw = true; return cmd;
        }

        static void Analyse(Snapshot s)
        {
            if (!s.Ok) { s.Alerts.Add(new Alert { Error = false, Text = "Нет данных: " + (s.Error ?? "?") }); return; }
            if (s.FreeMb < 1024) s.Alerts.Add(new Alert { Error = true, Text = "Мало памяти: " + Fmt.Gb(s.FreeMb) + " — новые задания ждут" });
            else if (s.FreeMb < 2048) s.Alerts.Add(new Alert { Error = false, Text = "Памяти немного: " + Fmt.Gb(s.FreeMb) });
            foreach (var se in s.Sessions)
                foreach (var j in se.Jobs)
                    if (j.State == "running" && j.IdleS >= 900)
                        s.Alerts.Add(new Alert { Error = true, Text = j.Model + " «" + j.Name + "» молчит " + Fmt.Duration(j.IdleS) + " — похоже, завис" });
            if (s.DaemonRunning && !s.DaemonHealthy) s.Alerts.Add(new Alert { Error = true, Text = "Демон Codex не отвечает" });
            else if (s.DaemonRunning && s.AppServerDown) s.Alerts.Add(new Alert { Error = false, Text = "Codex перезапускается" });
            if (s.CodexReached) s.Alerts.Add(new Alert { Error = true, Text = "Лимит Codex исчерпан" });
            foreach (var l in s.Limits)
            {
                if (l.Pct >= 90) s.Alerts.Add(new Alert { Error = true, Text = "Лимит " + l.Label + ": " + Math.Round(l.Pct) + "%" });
                else if (l.Pct >= 75) s.Alerts.Add(new Alert { Error = false, Text = "Лимит " + l.Label + ": " + Math.Round(l.Pct) + "%" });
            }
            s.Alerts = s.Alerts.OrderBy(a => a.Error ? 0 : 1).ToList();
        }
    }

    static class Fmt
    {
        public static string Duration(double totalS)
        {
            var sec = (long)Math.Max(0, Math.Round(totalS));
            if (sec < 60) return sec + "с";
            var m = sec / 60; if (m < 60) return m + "м";
            var h = m / 60; if (h < 48) return h + "ч " + (m % 60) + "м";
            return (h / 24) + "д " + (h % 24) + "ч";
        }
        public static string Gb(double mb) { return (mb / 1024).ToString("0.0", System.Globalization.CultureInfo.GetCultureInfo("ru-RU")) + " ГБ"; }
    }

    // ---- Palette (Windows 10 dark flyout) --------------------------------------------------------------------------
    static class Pal
    {
        public static readonly Color Bg = Color.FromArgb(31, 31, 31), Card = Color.FromArgb(43, 43, 43), CardHover = Color.FromArgb(50, 50, 50);
        public static readonly Color Line = Color.FromArgb(58, 58, 58), Text = Color.FromArgb(242, 242, 242), Sub = Color.FromArgb(160, 160, 160);
        public static readonly Color Ok = Color.FromArgb(108, 203, 95), Warn = Color.FromArgb(247, 201, 72), Err = Color.FromArgb(255, 107, 107);
        public static readonly Color Claude = Color.FromArgb(217, 119, 87), Codex = Color.FromArgb(122, 162, 247), Track = Color.FromArgb(64, 64, 64);
        public static Color Sev(double pct) { return pct >= 90 ? Err : pct >= 70 ? Warn : Ok; }
    }

    // ---- Settings (%APPDATA%\LunaWidget\settings.txt, key=value) ---------------------------------------------------
    static class Settings
    {
        static string FilePath { get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "LunaWidget", "settings.txt"); } }
        public static Dictionary<string, string> Load()
        {
            var d = new Dictionary<string, string>();
            try { foreach (var line in File.ReadAllLines(FilePath)) { var i = line.IndexOf('='); if (i > 0) d[line.Substring(0, i)] = line.Substring(i + 1); } } catch { }
            return d;
        }
        public static void Save(Dictionary<string, string> d)
        {
            try { Directory.CreateDirectory(Path.GetDirectoryName(FilePath)); File.WriteAllLines(FilePath, d.Select(kv => kv.Key + "=" + kv.Value)); } catch { }
        }
    }

    // ---- Tray application -------------------------------------------------------------------------------------------
    class TrayApp : ApplicationContext
    {
        readonly NotifyIcon tray = new NotifyIcon();
        readonly PanelForm panel;
        readonly System.Windows.Forms.Timer timer = new System.Windows.Forms.Timer();
        readonly SynchronizationContext ui;
        Snapshot last;
        bool polling;
        DateTime lastPoll = DateTime.MinValue;
        Icon currentIcon;
        ToolStripMenuItem pinItem, topItem, autoItem;
        const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";

        public TrayApp()
        {
            ui = SynchronizationContext.Current ?? new WindowsFormsSynchronizationContext();
            panel = new PanelForm(this);
            var menu = new ContextMenuStrip();
            menu.Items.Add("Открыть Luna", null, (s, e) => ShowPanel());
            pinItem = new ToolStripMenuItem("Закрепить на экране", null, (s, e) => SetPinned(!panel.Pinned));
            topItem = new ToolStripMenuItem("Поверх всех окон", null, (s, e) => SetTopMost(!panel.TopMost));
            autoItem = new ToolStripMenuItem("Запускать вместе с Windows", null, (s, e) => ToggleAutostart());
            menu.Items.Add(pinItem); menu.Items.Add(topItem); menu.Items.Add(autoItem);
            menu.Items.Add("Обновить сейчас", null, (s, e) => PollNow());
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add("Выход", null, (s, e) => Exit());
            menu.Opening += (s, e) => { pinItem.Checked = panel.Pinned; topItem.Checked = panel.TopMost; autoItem.Checked = AutostartOn(); };
            tray.ContextMenuStrip = menu;
            tray.Text = "Luna — загрузка…";
            SetIcon(Pal.Sub);
            tray.Visible = true;
            tray.MouseClick += (s, e) => { if (e.Button == MouseButtons.Left) TogglePanel(); };

            var st = Settings.Load();
            string v;
            if (st.TryGetValue("topmost", out v)) panel.TopMost = v == "1";
            if (st.TryGetValue("pinned", out v) && v == "1") SetPinned(true);

            timer.Interval = 1000;
            timer.Tick += (s, e) => { var every = panel.Visible ? 5 : 30; if ((DateTime.Now - lastPoll).TotalSeconds >= every) PollNow(); };
            timer.Start();
            PollNow();
        }

        public void PollNow()
        {
            if (polling) return;
            polling = true; lastPoll = DateTime.Now;
            ThreadPool.QueueUserWorkItem(_ =>
            {
                var snap = Collector.Poll();
                ui.Post(__ => { polling = false; Apply(snap); }, null);
            });
        }

        void Apply(Snapshot s)
        {
            last = s;
            var color = s.Alerts.Any(a => a.Error) ? Pal.Err : s.Alerts.Count > 0 ? Pal.Warn : s.Ok ? Pal.Ok : Pal.Sub;
            SetIcon(color, s.Running);
            var tip = s.Alerts.Count > 0 ? s.Alerts[0].Text : (s.Running > 0 ? "Codex: " + s.Running + " в работе" : "Codex свободен") + " · ОЗУ " + Fmt.Gb(s.FreeMb);
            tray.Text = ("Luna — " + tip).Length > 63 ? ("Luna — " + tip).Substring(0, 62) + "…" : "Luna — " + tip;
            panel.SetData(s);
        }

        void SetIcon(Color c, int running = 0)
        {
            var size = SystemInformation.SmallIconSize.Width;
            using (var bmp = new Bitmap(size, size))
            {
                using (var g = Graphics.FromImage(bmp))
                {
                    g.SmoothingMode = SmoothingMode.AntiAlias; g.Clear(Color.Transparent);
                    float pad = size * 0.12f, d = size - 2 * pad;
                    using (var b = new SolidBrush(c)) g.FillEllipse(b, pad, pad, d, d);
                    if (running > 0)
                    {
                        var txt = running > 9 ? "9+" : running.ToString();
                        using (var f = new Font("Segoe UI", size * (txt.Length > 1 ? 0.42f : 0.55f), FontStyle.Bold, GraphicsUnit.Pixel))
                        using (var tb = new SolidBrush(Color.FromArgb(25, 25, 25)))
                        {
                            var sz = g.MeasureString(txt, f);
                            g.TextRenderingHint = TextRenderingHint.AntiAliasGridFit;
                            g.DrawString(txt, f, tb, (size - sz.Width) / 2 + 0.5f, (size - sz.Height) / 2 + 0.5f);
                        }
                    }
                }
                var old = currentIcon;
                currentIcon = Icon.FromHandle(bmp.GetHicon());
                tray.Icon = currentIcon;
                if (old != null) { DestroyIcon(old.Handle); old.Dispose(); }
            }
        }
        [DllImport("user32.dll")] static extern bool DestroyIcon(IntPtr h);

        void TogglePanel() { if (panel.Visible && !panel.Pinned) panel.Hide(); else ShowPanel(); }

        void ShowPanel()
        {
            if (!panel.Pinned) panel.PlaceAtTray();
            panel.Show(); panel.Activate();
            if ((DateTime.Now - lastPoll).TotalSeconds > 4) PollNow();
        }

        public void SetPinned(bool on)
        {
            panel.SetPinned(on);
            var st = Settings.Load(); st["pinned"] = on ? "1" : "0"; Settings.Save(st);
            if (on) ShowPanel();
        }

        public void SetTopMost(bool on)
        {
            panel.TopMost = on;
            var st = Settings.Load(); st["topmost"] = on ? "1" : "0"; Settings.Save(st);
        }

        static string ExePath { get { return Application.ExecutablePath; } }
        static bool AutostartOn()
        {
            using (var k = Registry.CurrentUser.OpenSubKey(RunKey)) { var v = k == null ? null : k.GetValue("LunaWidget") as string; return v != null; }
        }
        static void ToggleAutostart()
        {
            using (var k = Registry.CurrentUser.CreateSubKey(RunKey))
            {
                if (k.GetValue("LunaWidget") != null) k.DeleteValue("LunaWidget", false);
                else k.SetValue("LunaWidget", "\"" + ExePath + "\"");
            }
        }

        public void Exit()
        {
            tray.Visible = false; timer.Stop(); panel.Close();
            if (currentIcon != null) { DestroyIcon(currentIcon.Handle); currentIcon.Dispose(); }
            ExitThread();
        }
    }

    // ---- The flyout / widget window, fully custom-drawn -------------------------------------------------------------
    class PanelForm : Form
    {
        readonly TrayApp app;
        Snapshot data;
        float scale = 1f;
        int scroll, contentHeight;
        public bool Pinned;
        Rectangle pinBtn, closeBtn;
        Point dragFrom; bool dragging;
        readonly HashSet<string> folded = new HashSet<string>();
        readonly List<KeyValuePair<Rectangle, string>> foldTargets = new List<KeyValuePair<Rectangle, string>>();

        Font fTitle, fHead, fBody, fSmall, fIcon, fMono;

        public PanelForm(TrayApp owner)
        {
            app = owner;
            FormBorderStyle = FormBorderStyle.None; ShowInTaskbar = false; StartPosition = FormStartPosition.Manual;
            BackColor = Pal.Bg; DoubleBuffered = true; KeyPreview = true;
            using (var g = CreateGraphics()) scale = g.DpiX / 96f;
            fTitle = new Font("Segoe UI Semibold", 11.5f); fHead = new Font("Segoe UI Semibold", 9.5f);
            fBody = new Font("Segoe UI", 9f); fSmall = new Font("Segoe UI", 8f);
            fIcon = new Font("Segoe MDL2 Assets", 9f); fMono = new Font("Consolas", 8f);
            Width = S(380); Height = S(200);
            Deactivate += (s, e) => { if (!Pinned) Hide(); };
            KeyDown += (s, e) => { if (e.KeyCode == Keys.Escape && !Pinned) Hide(); };
            MouseWheel += (s, e) => { scroll = Math.Max(0, Math.Min(Math.Max(0, contentHeight - ClientSize.Height), scroll - e.Delta / 2)); Invalidate(); };
            var st = Settings.Load(); string v;
            if (st.TryGetValue("x", out v) && st.ContainsKey("y")) { int x, y; if (int.TryParse(v, out x) && int.TryParse(st["y"], out y)) Location = new Point(x, y); }
        }

        int S(float v) { return (int)Math.Round(v * scale); }

        protected override CreateParams CreateParams
        {
            get { var cp = base.CreateParams; cp.ClassStyle |= 0x00020000; /* CS_DROPSHADOW */ cp.ExStyle |= 0x00000080; /* TOOLWINDOW */ return cp; }
        }

        public void SetPinned(bool on)
        {
            Pinned = on;
            if (!on) { PlaceAtTray(); }
            Invalidate();
        }

        public void PlaceAtTray()
        {
            var wa = Screen.PrimaryScreen.WorkingArea; var b = Screen.PrimaryScreen.Bounds;
            int m = S(12);
            int x = wa.Right - Width - m, y = wa.Bottom - Height - m;
            if (wa.Top > b.Top) y = wa.Top + m;        // taskbar on top
            if (wa.Left > b.Left) x = wa.Left + m;     // taskbar on the left
            Location = new Point(x, y);
        }

        public void SetData(Snapshot s)
        {
            data = s;
            Measure();
            Invalidate();
        }

        void Measure()
        {
            using (var g = CreateGraphics()) contentHeight = Draw(g, true);
            var wa = Screen.PrimaryScreen.WorkingArea;
            int h = Math.Min(contentHeight, (int)(wa.Height * 0.8));
            Height = Math.Max(S(120), h);
            if (!Pinned) PlaceAtTray();
            scroll = Math.Max(0, Math.Min(scroll, Math.Max(0, contentHeight - Height)));
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
            e.Graphics.TextRenderingHint = TextRenderingHint.ClearTypeGridFit;
            Draw(e.Graphics, false);
            using (var p = new Pen(Pal.Line)) e.Graphics.DrawRectangle(p, 0, 0, Width - 1, Height - 1);
        }

        // Draws (or only measures) the whole panel; returns the content height.
        int Draw(Graphics g, bool measure)
        {
            foldTargets.Clear();
            int pad = S(14), w = Width - 2 * pad, y = pad - (measure ? 0 : scroll);
            var s = data;
            // Header: title, overall status, pin and close buttons.
            Color status = s == null ? Pal.Sub : s.Alerts.Any(a => a.Error) ? Pal.Err : s.Alerts.Count > 0 ? Pal.Warn : Pal.Ok;
            string statusText = s == null ? "загрузка…" : s.Alerts.Count == 0 ? "всё в порядке" : "требует внимания · " + s.Alerts.Count;
            if (!measure)
            {
                TextRenderer.DrawText(g, "Luna", fTitle, new Point(pad, y), Pal.Text, TextFormatFlags.NoPadding);
                int tx = pad + TextRenderer.MeasureText(g, "Luna", fTitle, Size.Empty, TextFormatFlags.NoPadding).Width + S(10);
                using (var b = new SolidBrush(status)) g.FillEllipse(b, tx, y + S(7), S(8), S(8));
                TextRenderer.DrawText(g, statusText, fBody, new Point(tx + S(13), y + S(2)), status, TextFormatFlags.NoPadding);
                closeBtn = new Rectangle(Width - pad - S(18), y, S(18), S(20));
                pinBtn = new Rectangle(closeBtn.Left - S(26), y, S(20), S(20));
                TextRenderer.DrawText(g, Pinned ? "" : "", fIcon, pinBtn, Pinned ? Pal.Codex : Pal.Sub, TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter);
                TextRenderer.DrawText(g, "", fIcon, closeBtn, Pal.Sub, TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter);
            }
            y += S(30);
            if (s == null) return y + pad + (measure ? 0 : scroll);

            // Attention block.
            if (s.Alerts.Count > 0)
            {
                int h = S(12) + s.Alerts.Count * S(20);
                if (!measure)
                {
                    FillRound(g, new Rectangle(pad, y, w, h), S(8), Pal.Card);
                    int ay = y + S(6);
                    foreach (var a in s.Alerts)
                    {
                        var c = a.Error ? Pal.Err : Pal.Warn;
                        using (var b = new SolidBrush(c)) g.FillEllipse(b, pad + S(10), ay + S(6), S(7), S(7));
                        TextRenderer.DrawText(g, a.Text, fBody, new Rectangle(pad + S(24), ay, w - S(32), S(20)), c, TextFormatFlags.EndEllipsis | TextFormatFlags.NoPadding);
                        ay += S(20);
                    }
                }
                y += h + S(10);
            }

            // Resources: memory, limits, daemon.
            var rows = new List<Tuple<string, string, double, Color, string>>();
            double used = 100 - s.FreeMb / Math.Max(1, s.TotalMb) * 100;
            rows.Add(Tuple.Create("Память", Fmt.Gb(s.FreeMb) + " свободно", used, s.FreeMb < 1024 ? Pal.Err : s.FreeMb < 2048 ? Pal.Warn : Pal.Ok, (string)null));
            foreach (var l in s.Limits) rows.Add(Tuple.Create(l.Label, Math.Round(l.Pct) + "%", l.Pct, Pal.Sev(l.Pct), l.Pct >= 70 ? l.Resets : null));
            int resH = S(34) + rows.Sum(r => S(r.Item5 != null ? 36 : 22)) + S(26);
            if (!measure)
            {
                FillRound(g, new Rectangle(pad, y, w, resH), S(8), Pal.Card);
                TextRenderer.DrawText(g, "Ресурсы", fHead, new Point(pad + S(12), y + S(9)), Pal.Text, TextFormatFlags.NoPadding);
                int ry = y + S(34);
                foreach (var r in rows)
                {
                    TextRenderer.DrawText(g, r.Item1, fBody, new Point(pad + S(12), ry), Pal.Text, TextFormatFlags.NoPadding);
                    int meterW = S(70), mx = pad + w - S(12) - meterW;
                    var vs = TextRenderer.MeasureText(g, r.Item2, fBody, Size.Empty, TextFormatFlags.NoPadding);
                    TextRenderer.DrawText(g, r.Item2, fBody, new Point(mx - S(8) - vs.Width, ry), r.Item4, TextFormatFlags.NoPadding);
                    FillRound(g, new Rectangle(mx, ry + S(6), meterW, S(6)), S(3), Pal.Track);
                    int fw = Math.Max(S(6), (int)(meterW * Math.Min(100, Math.Max(0, r.Item3)) / 100));
                    FillRound(g, new Rectangle(mx, ry + S(6), fw, S(6)), S(3), r.Item4);
                    if (r.Item5 != null) TextRenderer.DrawText(g, r.Item5, fSmall, new Point(pad + S(12), ry + S(17)), Pal.Sub, TextFormatFlags.NoPadding);
                    ry += S(r.Item5 != null ? 36 : 22);
                }
                var dColor = !s.DaemonRunning ? Pal.Sub : !s.DaemonHealthy ? Pal.Err : s.AppServerDown ? Pal.Warn : Pal.Ok;
                var dText = !s.DaemonRunning ? "спит, проснётся с первым заданием" : !s.DaemonHealthy ? "не отвечает" : s.AppServerDown ? "Codex перезапускается"
                    : s.DaemonRunningJobs + (s.DaemonMax > 0 ? "/" + s.DaemonMax : "") + " в работе · очередь " + s.DaemonQueued + " · " + Fmt.Duration(s.DaemonUptimeS);
                using (var b = new SolidBrush(dColor)) g.FillEllipse(b, pad + S(12), ry + S(5), S(7), S(7));
                TextRenderer.DrawText(g, "Демон Codex", fBody, new Point(pad + S(25), ry), Pal.Text, TextFormatFlags.NoPadding);
                var ds = TextRenderer.MeasureText(g, dText, fSmall, Size.Empty, TextFormatFlags.NoPadding);
                TextRenderer.DrawText(g, dText, fSmall, new Point(pad + w - S(12) - ds.Width, ry + S(1)), Pal.Sub, TextFormatFlags.NoPadding);
            }
            y += resH + S(10);

            // Sessions.
            if (s.Sessions.Count == 0)
            {
                if (!measure) TextRenderer.DrawText(g, "Сессии с заданиями Codex появятся здесь.", fBody, new Point(pad, y), Pal.Sub, TextFormatFlags.NoPadding);
                y += S(24);
            }
            foreach (var se in s.Sessions)
            {
                bool open = !folded.Contains(se.Id);
                int h = S(34) + (open ? S(22) + se.Agents.Count * S(20) + se.Jobs.Sum(j => S(j.Activity != null || IsQuiet(j) ? 40 : 22)) + S(6) : 0);
                if (!measure)
                {
                    var rect = new Rectangle(pad, y, w, h);
                    FillRound(g, rect, S(8), Pal.Card);
                    foldTargets.Add(new KeyValuePair<Rectangle, string>(new Rectangle(pad, y, w, S(30)), se.Id));
                    TextRenderer.DrawText(g, (open ? "  " : "  "), fIcon, new Point(pad + S(10), y + S(11)), Pal.Sub, TextFormatFlags.NoPadding);
                    TextRenderer.DrawText(g, se.Name, fHead, new Point(pad + S(28), y + S(8)), Pal.Text, TextFormatFlags.NoPadding);
                    var running = se.Jobs.Count(j => j.State == "running");
                    var summary = (se.Jobs.Count > 0 ? "Codex " + running + (se.Jobs.Count > running ? "+" + (se.Jobs.Count - running) : "") : "");
                    var ss = TextRenderer.MeasureText(g, summary, fSmall, Size.Empty, TextFormatFlags.NoPadding);
                    TextRenderer.DrawText(g, summary, fSmall, new Point(pad + w - S(12) - ss.Width, y + S(10)), Pal.Codex, TextFormatFlags.NoPadding);
                    if (open)
                    {
                        int ry = y + S(34);
                        var cc = se.ClaudeState == 1 ? Pal.Claude : se.ClaudeState == 2 ? Pal.Claude : Pal.Sub;
                        using (var b = new SolidBrush(cc)) g.FillEllipse(b, pad + S(12), ry + S(5), S(7), S(7));
                        TextRenderer.DrawText(g, "Claude", fHead, new Point(pad + S(25), ry), Pal.Text, TextFormatFlags.NoPadding);
                        var cs = se.ClaudeSinceS > 0 ? Fmt.Duration(se.ClaudeSinceS) : "";
                        var csz = TextRenderer.MeasureText(g, cs, fSmall, Size.Empty, TextFormatFlags.NoPadding);
                        TextRenderer.DrawText(g, se.ClaudeText ?? "", fBody, new Rectangle(pad + S(80), ry, w - S(100) - csz.Width, S(20)), se.ClaudeState == 3 || se.ClaudeState == 0 ? Pal.Sub : Pal.Text, TextFormatFlags.EndEllipsis | TextFormatFlags.NoPadding);
                        TextRenderer.DrawText(g, cs, fSmall, new Point(pad + w - S(12) - csz.Width, ry + S(1)), Pal.Sub, TextFormatFlags.NoPadding);
                        ry += S(22);
                        foreach (var a in se.Agents)
                        {
                            TextRenderer.DrawText(g, "◇  агент: " + a, fBody, new Rectangle(pad + S(12), ry, w - S(24), S(20)), Pal.Sub, TextFormatFlags.EndEllipsis | TextFormatFlags.NoPadding);
                            ry += S(20);
                        }
                        foreach (var j in se.Jobs) ry = DrawJob(g, j, pad, w, ry);
                    }
                }
                y += h + S(8);
            }

            if (!measure)
                TextRenderer.DrawText(g, "обновлено " + s.At.ToString("HH:mm:ss"), fSmall, new Point(pad, y), Pal.Sub, TextFormatFlags.NoPadding);
            y += S(22);
            return y + (measure ? 0 : scroll);
        }

        static bool IsQuiet(JobView j) { return j.State == "running" && j.IdleS >= 300; }

        int DrawJob(Graphics g, JobView j, int pad, int w, int ry)
        {
            bool running = j.State == "running";
            var quiet = running && j.IdleS >= 900 ? Pal.Err : running && j.IdleS >= 300 ? Pal.Warn : Color.Empty;
            var glyphColor = quiet != Color.Empty ? quiet : running ? Pal.Ok : Pal.Warn;
            TextRenderer.DrawText(g, running ? "" : "", fIcon, new Point(pad + S(10), ry + S(3)), glyphColor, TextFormatFlags.NoPadding);
            var right = running ? Fmt.Duration(j.AgeS) : (j.State == "queued" ? "в очереди" : j.State.StartsWith("waiting-") ? "ждёт" : j.State) + " · " + Fmt.Duration(j.AgeS);
            var rs = TextRenderer.MeasureText(g, right, fSmall, Size.Empty, TextFormatFlags.NoPadding);
            TextRenderer.DrawText(g, right, fSmall, new Point(pad + w - S(12) - rs.Width, ry + S(1)), Pal.Sub, TextFormatFlags.NoPadding);
            TextRenderer.DrawText(g, j.Model, fHead, new Point(pad + S(28), ry), Pal.Codex, TextFormatFlags.NoPadding);
            var ms = TextRenderer.MeasureText(g, j.Model, fHead, Size.Empty, TextFormatFlags.NoPadding);
            TextRenderer.DrawText(g, j.Name, fBody, new Rectangle(pad + S(32) + ms.Width, ry, w - S(52) - ms.Width - rs.Width, S(20)), running ? Pal.Text : Pal.Sub, TextFormatFlags.EndEllipsis | TextFormatFlags.NoPadding);
            ry += S(20);
            string second = null; Color sc = Pal.Sub;
            if (quiet != Color.Empty) { second = "тишина " + Fmt.Duration(j.IdleS) + (quiet == Pal.Err ? " — похоже, завис" : " — возможно, думает"); sc = quiet; }
            else if (j.Activity != null) second = j.Activity;
            if (second != null)
            {
                TextRenderer.DrawText(g, second, j.ActivityRaw && quiet == Color.Empty ? fMono : fSmall,
                    new Rectangle(pad + S(28), ry, w - S(40), S(18)), sc, TextFormatFlags.EndEllipsis | TextFormatFlags.NoPadding);
                ry += S(20);
            }
            else ry += S(2);
            return ry;
        }

        static void FillRound(Graphics g, Rectangle r, int radius, Color c)
        {
            using (var path = new GraphicsPath())
            {
                int d = radius * 2;
                if (r.Width < d || r.Height < d) { using (var b = new SolidBrush(c)) g.FillRectangle(b, r); return; }
                path.AddArc(r.X, r.Y, d, d, 180, 90); path.AddArc(r.Right - d, r.Y, d, d, 270, 90);
                path.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90); path.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
                path.CloseFigure();
                using (var b = new SolidBrush(c)) g.FillPath(b, path);
            }
        }

        protected override void OnMouseDown(MouseEventArgs e)
        {
            base.OnMouseDown(e);
            if (e.Button != MouseButtons.Left) return;
            if (pinBtn.Contains(e.Location)) { app.SetPinned(!Pinned); return; }
            if (closeBtn.Contains(e.Location)) { if (Pinned) app.SetPinned(false); Hide(); return; }
            foreach (var t in foldTargets)
                if (t.Key.Contains(e.Location)) { if (!folded.Remove(t.Value)) folded.Add(t.Value); Measure(); Invalidate(); return; }
            if (Pinned && e.Y < S(40)) { dragging = true; dragFrom = e.Location; }
        }

        protected override void OnMouseMove(MouseEventArgs e)
        {
            base.OnMouseMove(e);
            if (dragging) Location = new Point(Location.X + e.X - dragFrom.X, Location.Y + e.Y - dragFrom.Y);
            Cursor = pinBtn.Contains(e.Location) || closeBtn.Contains(e.Location) || foldTargets.Any(t => t.Key.Contains(e.Location)) ? Cursors.Hand : Cursors.Default;
        }

        protected override void OnMouseUp(MouseEventArgs e)
        {
            base.OnMouseUp(e);
            if (!dragging) return;
            dragging = false;
            var st = Settings.Load(); st["x"] = Location.X.ToString(); st["y"] = Location.Y.ToString(); Settings.Save(st);
        }
    }
}
