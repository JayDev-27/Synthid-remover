interface ProcessingLogsProps {
  logs: string[];
  isProcessing: boolean;
  executionTimeMs?: number;
  dimensions?: { width: number; height: number };
  originalSize?: number;
  processedSize?: number;
}

export function ProcessingLogs({
  logs, isProcessing, executionTimeMs, dimensions, originalSize, processedSize,
}: ProcessingLogsProps) {
  const measurements = [
    ['Duration', executionTimeMs === undefined ? null : `${Math.round(executionTimeMs)} ms`],
    ['Dimensions', dimensions ? `${dimensions.width} × ${dimensions.height}` : null],
    ['Input', originalSize === undefined ? null : `${(originalSize / 1024).toFixed(1)} KB`],
    ['Output', processedSize === undefined ? null : `${(processedSize / 1024).toFixed(1)} KB`],
  ];

  return (
    <section aria-labelledby="processing-log-heading" className="rounded-xl border border-neutral-800 bg-neutral-950 p-4 font-mono text-xs text-neutral-200">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 id="processing-log-heading" className="font-semibold text-white">Processing log</h2>
        <span role="status">{isProcessing ? 'Processing…' : 'Idle'}</span>
      </div>
      <ol aria-label="Processing events" role="log" className="mt-3 max-h-52 space-y-1 overflow-y-auto break-words">
        {logs.map((line, index) => <li key={index}>{line}</li>)}
      </ol>
      <dl className="mt-4 flex flex-wrap gap-4">
        {measurements.map(([label, value]) => value !== null && (
          <div key={label}>
            <dt className="text-neutral-400">{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
