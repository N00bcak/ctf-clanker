import type { SchedulerStatus as Status } from "./api";

export function formatCpu(value: number): string {
    return Number(value.toFixed(2)).toString();
}

export function formatMemory(value: number): string {
    return value >= 1024 ? `${Number((value / 1024).toFixed(2))} GiB` : `${Math.round(value)} MiB`;
}

export function SchedulerStatus({ status, error }: { status?: Status; error?: string }) {
    const state = error ? "unavailable" : status?.state;
    return (
        <section className="scheduler-status" aria-label="Local Docker scheduler">
            <header><strong>Local Docker</strong><span className={`scheduler-state scheduler-state-${state ?? "loading"}`}>{state ?? "Loading"}</span></header>
            {(error || status?.reason) && <p className="scheduler-reason" role="status">{error ? `Scheduler unavailable: ${error}` : status?.reason}</p>}
            {status && <>
                <dl>
                    <div><dt>Workers</dt><dd>{status.activeWorkers} active / {status.effectiveMaxWorkers ?? "unknown"} effective <span>({status.maxWorkers} max)</span></dd></div>
                    <div><dt>CPU</dt><dd>{status.cpuUsage === undefined ? "Usage unavailable" : `${formatCpu(status.cpuUsage)} used`}<span>{formatCpu(status.cpuAllocated)} allocated / {formatCpu(status.cpuBudget)} budget</span></dd></div>
                    <div><dt>RAM</dt><dd>{status.memoryUsageMb === undefined ? "Usage unavailable" : `${formatMemory(status.memoryUsageMb)} used`}<span>{formatMemory(status.memoryReservedMb)} reserved / {status.effectiveMemoryMb === undefined ? "capacity unavailable" : `${formatMemory(status.effectiveMemoryMb)} effective`}</span><span>{formatMemory(status.memoryBudgetMb)} budget · {formatMemory(status.workerMemoryMb)} per worker</span></dd></div>
                </dl>
                {status.sampledAt && <time dateTime={status.sampledAt}>Sampled {new Date(status.sampledAt).toLocaleTimeString()}</time>}
            </>}
        </section>
    );
}
