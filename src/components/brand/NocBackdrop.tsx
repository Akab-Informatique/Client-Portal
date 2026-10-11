import { useEffect, useRef, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import { cn } from "@/lib/utils";

/**
 * "Behind the scenes" NOC panels for the sign-in page: a PowerShell window,
 * a Linux monitoring terminal and an SLA server list, all live-updating.
 * Decorative only (aria-hidden, generic host names, no real data), dimmed and
 * angled toward the edges so the sign-in card keeps the visual focus.
 */
export function NocBackdrop() {
  return (
    <div className="pointer-events-none absolute inset-0 hidden select-none [zoom:0.74] xl:block 2xl:[zoom:1]" aria-hidden="true" style={{ perspective: 1400 }}>
      <Panel className="left-[3%] top-[9%] w-[500px]" rotate={16} delay={0.2}>
        <WindowChrome title="Administrator: Windows PowerShell" kind="win" />
        <Terminal prompt="PS C:\NOC>" script={PS_SCRIPT} rows={13} />
      </Panel>
      <Panel className="bottom-[7%] left-[6%] w-[460px]" rotate={12} delay={0.45}>
        <WindowChrome title="noc@akab-mon01: ~" kind="mac" />
        <Terminal prompt="noc@akab-mon01:~$" script={SH_SCRIPT} rows={10} speed={1.15} />
      </Panel>
      <Panel className="right-[3%] top-[12%] w-[480px]" rotate={-16} delay={0.3}>
        <WindowChrome title="SLA Monitor — 24/7" kind="mac" />
        <SlaMonitor />
      </Panel>
    </div>
  );
}

function Panel({ className, rotate, delay, children }: { className: string; rotate: number; delay: number; children: React.ReactNode }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 0.5, y: 0 }}
      transition={{ delay, duration: 1.2, ease: [0.22, 1, 0.36, 1] }}
      style={{ rotateY: rotate, transformOrigin: rotate > 0 ? "left center" : "right center" }}
      className={cn(
        "absolute overflow-hidden rounded-lg border border-white/[0.07] bg-[#0d0e11]/70 shadow-2xl backdrop-blur-[2px]",
        "[mask-image:linear-gradient(to_bottom,black_70%,transparent)]",
        className,
      )}
    >
      {children}
    </motion.div>
  );
}

function WindowChrome({ title, kind }: { title: string; kind: "win" | "mac" }) {
  return (
    <div className="flex h-7 items-center gap-2 border-b border-white/[0.06] bg-white/[0.03] px-3 font-mono text-[10.5px] text-[#8a8c94]">
      {kind === "mac" ? (
        <span className="flex gap-1.5">
          <span className="size-2 rounded-full bg-[#ff5f57]/60" />
          <span className="size-2 rounded-full bg-[#febc2e]/60" />
          <span className="size-2 rounded-full bg-[#28c840]/60" />
        </span>
      ) : (
        <span className="text-[#5b8def]/80">❯_</span>
      )}
      <span className="truncate">{title}</span>
      {kind === "win" && <span className="ml-auto tracking-[0.4em] text-[#5d5f66]">–□×</span>}
    </div>
  );
}

// ── Terminals ────────────────────────────────────────────────────────────────
type Line = ["cmd" | "out" | "ok" | "warn" | "dim", string];

const PS_SCRIPT: Line[] = [
  ["cmd", "Get-Service -ComputerName SRV-DC01 NTDS,DNS,Netlogon | ft Name,Status"],
  ["out", "NTDS        Running"],
  ["out", "DNS         Running"],
  ["out", "Netlogon    Running"],
  ["cmd", "Test-NetConnection fw-edge01 -Port 443 | select TcpTestSucceeded"],
  ["ok", "TcpTestSucceeded : True"],
  ["cmd", "Get-VBRJob -Name 'Nightly-SRV-FS01' | Get-VBRJobLastResult"],
  ["ok", "Success   412.6 GB transferred   0 warnings   0 errors"],
  ["cmd", "Get-MpComputerStatus | select AntivirusSignatureVersion,RealTimeProtectionEnabled"],
  ["out", "1.417.552.0                 True"],
  ["cmd", "Get-WindowsUpdate -ComputerName SRV-SQL01 -Install -AcceptAll -IgnoreReboot"],
  ["out", "KB5044284   2026-10 Cumulative Update   Installed"],
  ["warn", "WARNING: reboot scheduled 22:00 (maintenance window)"],
  ["cmd", "Get-PSDrive C | select @{n='Used(GB)';e={[int]($_.Used/1GB)}},@{n='Free(GB)';e={[int]($_.Free/1GB)}}"],
  ["out", "Used(GB) Free(GB)"],
  ["out", "     186      114"],
  ["cmd", "Invoke-Command SRV-RDS01 { (quser | measure).Count - 1 }"],
  ["out", "14"],
  ["cmd", "Get-ADReplicationFailure -Target SRV-DC01 | measure | select Count"],
  ["ok", "Count : 0"],
];

const SH_SCRIPT: Line[] = [
  ["cmd", "ping -c 2 pbx-voip01"],
  ["out", "64 bytes from 10.20.0.15: icmp_seq=1 ttl=63 time=2.81 ms"],
  ["out", "64 bytes from 10.20.0.15: icmp_seq=2 ttl=63 time=2.64 ms"],
  ["cmd", "systemctl is-active zabbix-agent2 nginx postgresql"],
  ["ok", "active"],
  ["ok", "active"],
  ["ok", "active"],
  ["cmd", "echo | openssl s_client -connect portail.akab.ca:443 2>/dev/null | openssl x509 -noout -enddate"],
  ["out", "notAfter=Dec 21 12:00:00 2026 GMT"],
  ["cmd", "snmpwalk -v2c -c ******** sw-core01 IF-MIB::ifOperStatus | grep -c 'up(1)'"],
  ["out", "48"],
  ["cmd", "df -h /backup | tail -1"],
  ["out", "/dev/sdb1   8.0T  5.1T  2.9T  64% /backup"],
  ["cmd", "tail -n 1 /var/log/veeam/veeam.log"],
  ["ok", "[INFO] Job 'Linux-Web01' finished: Success, 0 errors"],
];

const COLORS: Record<Line[0], string> = {
  cmd: "text-[#d6d7dc]",
  out: "text-[#8a8c94]",
  ok: "text-[#34d399]/80",
  warn: "text-[#fbbf24]/85",
  dim: "text-[#5d5f66]",
};

function stamp() {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function Terminal({ prompt, script, rows, speed = 1 }: { prompt: string; script: Line[]; rows: number; speed?: number }) {
  const reduce = useReducedMotion();
  const [lines, setLines] = useState<{ kind: Line[0]; text: string; time: string }[]>(() =>
    reduce ? script.slice(0, rows).map(([k, t]) => ({ kind: k, text: t, time: stamp() })) : [],
  );
  const [typing, setTyping] = useState("");
  const idx = useRef(0);

  useEffect(() => {
    if (reduce) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const wait = (ms: number) => new Promise<void>((r) => (timer = setTimeout(r, ms / speed)));

    async function run() {
      await wait(900);
      while (alive) {
        if (document.hidden) {
          await wait(1000);
          continue;
        }
        const [kind, text] = script[idx.current % script.length];
        idx.current++;
        if (kind === "cmd") {
          for (let i = 1; i <= text.length && alive; i += 2) {
            setTyping(text.slice(0, i));
            await wait(28);
          }
          setTyping("");
          push(kind, text);
          await wait(450 + Math.random() * 500);
        } else {
          push(kind, text);
          await wait(160 + Math.random() * 220);
        }
        if (idx.current % script.length === 0) await wait(2200);
      }
    }
    function push(kind: Line[0], text: string) {
      setLines((l) => [...l, { kind, text, time: stamp() }].slice(-(rows - 1)));
    }
    void run();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [reduce, rows, script, speed]);

  return (
    <div className="space-y-[3px] p-3 font-mono text-[10.5px] leading-[1.45]" style={{ height: rows * 18 + 24 }}>
      {lines.map((l, i) => (
        <div key={i} className={cn("truncate", COLORS[l.kind])}>
          {l.kind === "cmd" ? (
            <>
              <span className="text-[#ffce1a]/70">{prompt}</span> {l.text}
            </>
          ) : (
            l.text
          )}
        </div>
      ))}
      <div className="truncate text-[#d6d7dc]">
        <span className="text-[#ffce1a]/70">{prompt}</span> {typing}
        <span className="ml-px inline-block h-[11px] w-[6px] translate-y-[1px] animate-pulse bg-[#ffce1a]/70" />
      </div>
    </div>
  );
}

// ── SLA monitor ─────────────────────────────────────────────────────────────
const HOSTS = [
  { host: "SRV-DC01", role: "AD / DNS", sla: "99.99", days: 112 },
  { host: "SRV-FS01", role: "Files", sla: "99.98", days: 64 },
  { host: "SRV-SQL01", role: "SQL", sla: "99.97", days: 21 },
  { host: "SRV-RDS01", role: "RDS", sla: "99.95", days: 9 },
  { host: "FW-EDGE01", role: "Firewall", sla: "100.00", days: 203 },
  { host: "SW-CORE01", role: "Switch", sla: "100.00", days: 341 },
  { host: "BKP-VEEAM01", role: "Backup", sla: "99.99", days: 47 },
  { host: "PBX-VOIP01", role: "VoIP", sla: "99.98", days: 88 },
  { host: "M365-TENANT", role: "Cloud", sla: "99.99", days: 365 },
  { host: "WEB-PORTAIL", role: "Portal", sla: "100.00", days: 31 },
];

function SlaMonitor() {
  const reduce = useReducedMotion();
  const start = useRef(Date.now() - 7 * 3600_000);
  const [, setTick] = useState(0);
  const step = useRef(0);
  const [lat, setLat] = useState(() => HOSTS.map(() => 2 + Math.random() * 20));

  useEffect(() => {
    if (reduce) return;
    const i = setInterval(() => {
      if (document.hidden) return;
      const k0 = step.current++ % 3;
      setTick((t) => t + 1);
      setLat((l) => l.map((v, k) => (k % 3 === k0 ? Math.max(1, v + (Math.random() - 0.5) * 4) : v)));
    }, 1000);
    return () => clearInterval(i);
  }, [reduce]);

  const up = (days: number) => {
    const s = Math.floor((Date.now() - start.current) / 1000);
    const p = (n: number) => String(n).padStart(2, "0");
    return `${days}d ${p(Math.floor(s / 3600) % 24)}:${p(Math.floor(s / 60) % 60)}:${p(s % 60)}`;
  };

  return (
    <div className="p-3 font-mono text-[10.5px]">
      <div className="mb-2 flex items-center justify-between text-[#8a8c94]">
        <span className="flex items-center gap-1.5 text-[#34d399]/85">
          <span className="relative flex size-1.5">
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-[#34d399] opacity-60" />
            <span className="relative inline-flex size-1.5 rounded-full bg-[#34d399]" />
          </span>
          ALL SYSTEMS OPERATIONAL
        </span>
        <span>{HOSTS.length}/{HOSTS.length} UP</span>
      </div>
      <div className="grid grid-cols-[1.3fr_0.85fr_0.4fr_1.35fr_0.65fr_0.4fr] gap-x-2 whitespace-nowrap border-b border-white/[0.06] pb-1 text-[#5d5f66]">
        <span>HOST</span>
        <span>ROLE</span>
        <span>STATE</span>
        <span>UPTIME</span>
        <span>SLA %</span>
        <span className="text-right">MS</span>
      </div>
      {HOSTS.map((h, i) => (
        <div key={h.host} className="grid grid-cols-[1.3fr_0.85fr_0.4fr_1.35fr_0.65fr_0.4fr] gap-x-2 whitespace-nowrap border-b border-white/[0.03] py-[3px] text-[#a3a5ad]">
          <span className="truncate text-[#d6d7dc]">{h.host}</span>
          <span className="truncate">{h.role}</span>
          <span className="text-[#34d399]/85">UP</span>
          <span className="tabular-nums">{up(h.days)}</span>
          <span className="tabular-nums text-[#ffce1a]/75">{h.sla}</span>
          <span className="text-right tabular-nums">{lat[i].toFixed(0)}</span>
        </div>
      ))}
      <div className="mt-2 flex justify-between text-[#5d5f66]">
        <span>poll interval 60s · ICMP / SNMP / agent</span>
        <span className="tabular-nums">last poll {stamp()}</span>
      </div>
    </div>
  );
}
