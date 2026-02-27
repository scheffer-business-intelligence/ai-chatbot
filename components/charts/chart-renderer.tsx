"use client";

import { toBlob, toPng } from "html-to-image";
import {
  Check,
  Copy,
  Download,
  Maximize2,
  RotateCcw,
  TriangleAlert,
} from "lucide-react";
import { type Ref, useEffect, useMemo, useRef, useState } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  LabelList,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { toast } from "sonner";
import type { ChartSpecV1 } from "@/lib/charts/schema";
import { chartSpecSchema } from "@/lib/charts/schema";
import { cn } from "@/lib/utils";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";

type ChartRendererProps = {
  chartSpec?: unknown | null;
  chartWarning?: string | null;
  className?: string;
};

type ChartSeries = {
  key: string;
  label: string;
  color: string;
};

type CartesianRow = {
  x: string;
} & Record<string, number | string>;

type CartesianModel = {
  kind: "cartesian";
  chartType: Exclude<ChartSpecV1["type"], "pie">;
  rows: CartesianRow[];
  series: ChartSeries[];
  xLabel: string;
  yLabel: string;
  unit?: string;
};

type PieSlice = {
  key: string;
  name: string;
  value: number;
  color: string;
};

type PieModel = {
  kind: "pie";
  slices: PieSlice[];
};

type ChartModel = CartesianModel | PieModel;

type ZoomRange = {
  startIndex: number;
  endIndex: number;
};

const DEFAULT_COLORS = ["#22c55e", "#0ea5e9", "#f97316", "#eab308", "#ef4444"];

const EXPORT_OPTIONS = {
  cacheBust: true,
  pixelRatio: 2,
  backgroundColor: "#ffffff",
};

function getColor(index: number, preferred?: string) {
  return preferred ?? DEFAULT_COLORS[index % DEFAULT_COLORS.length];
}

function toNumericValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const normalized = value.replace(",", ".").trim();
    if (!normalized) {
      return null;
    }

    const parsed = Number(normalized);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return null;
}

function slugifyTitle(value: string) {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
}

function truncateLabel(value: string, limit = 24) {
  if (value.length <= limit) {
    return value;
  }

  return `${value.slice(0, limit - 1)}...`;
}

function humanizeKey(value: string) {
  const normalized = value.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();

  if (!normalized) {
    return value;
  }

  return normalized.replace(/\b\w/g, (char) => char.toUpperCase());
}

function formatNumber(value: number, unit?: string) {
  const formatted = value.toLocaleString("pt-BR", {
    maximumFractionDigits: 2,
  });

  return unit ? `${formatted} ${unit}` : formatted;
}

function formatTooltipValue(value: unknown, unit?: string) {
  const numeric = toNumericValue(value);
  if (numeric === null) {
    return String(value ?? "-");
  }

  return formatNumber(numeric, unit);
}

function formatBarLabel(value: unknown) {
  const numeric = toNumericValue(value);
  if (numeric === null) {
    return "";
  }

  return numeric.toLocaleString("pt-BR", {
    maximumFractionDigits: 2,
  });
}

function getAxisLabels(spec: ChartSpecV1, series: ChartSeries[]) {
  const xLabel = spec.xLabel ?? (spec.xKey ? humanizeKey(spec.xKey) : "Eixo X");

  const fallbackY = spec.yKey
    ? humanizeKey(spec.yKey)
    : series.length === 1
      ? series[0].label
      : "Valores";

  const yLabelBase = spec.yLabel ?? fallbackY;
  const yLabel = spec.unit ? `${yLabelBase} (${spec.unit})` : yLabelBase;

  return { xLabel, yLabel };
}

function normalizeWideCartesian(spec: ChartSpecV1): CartesianModel | null {
  if (!spec.xKey) {
    return null;
  }

  const inferredKeys = Array.from(
    spec.data.reduce((keys, row) => {
      for (const [key, value] of Object.entries(row)) {
        if (key === spec.xKey) {
          continue;
        }

        if (toNumericValue(value) !== null) {
          keys.add(key);
        }
      }

      return keys;
    }, new Set<string>())
  );

  const selectedSeries: Array<{
    key: string;
    label?: string;
    color?: string;
  }> =
    spec.series && spec.series.length > 0
      ? spec.series
      : inferredKeys.slice(0, 8).map((key) => ({ key, label: key }));

  const series: ChartSeries[] = selectedSeries.map((entry, index) => ({
    key: entry.key,
    label: entry.label ?? entry.key,
    color: getColor(index, entry.color),
  }));

  if (series.length === 0) {
    return null;
  }

  const rows: CartesianRow[] = spec.data.map((row, index) => {
    const rawX = row[spec.xKey as string];
    const xValue =
      rawX === undefined || rawX === null || String(rawX).trim() === ""
        ? `Item ${index + 1}`
        : String(rawX);

    const normalizedRow: CartesianRow = { x: xValue };

    for (const currentSeries of series) {
      normalizedRow[currentSeries.key] =
        toNumericValue(row[currentSeries.key]) ?? 0;
    }

    return normalizedRow;
  });

  const { xLabel, yLabel } = getAxisLabels(spec, series);

  return {
    kind: "cartesian",
    chartType: spec.type as CartesianModel["chartType"],
    rows,
    series,
    xLabel,
    yLabel,
    unit: spec.unit,
  };
}

function normalizeLongCartesian(spec: ChartSpecV1): CartesianModel | null {
  if (!spec.xKey || !spec.seriesKey || !spec.yKey) {
    return null;
  }

  const labels: string[] = [];
  const labelToIndex = new Map<string, number>();
  const seriesValues = new Map<string, number[]>();

  for (const row of spec.data) {
    const rawX: unknown = row[spec.xKey];
    if (rawX === undefined || rawX === null || String(rawX).trim() === "") {
      continue;
    }

    const xValue: string = String(rawX);

    if (!labelToIndex.has(xValue)) {
      labelToIndex.set(xValue, labels.length);
      labels.push(xValue);

      for (const values of seriesValues.values()) {
        values.push(0);
      }
    }

    const seriesName = String(row[spec.seriesKey] ?? "Serie");

    if (!seriesValues.has(seriesName)) {
      seriesValues.set(seriesName, new Array(labels.length).fill(0));
    }

    const values = seriesValues.get(seriesName);
    if (!values) {
      continue;
    }

    if (values.length < labels.length) {
      while (values.length < labels.length) {
        values.push(0);
      }
    }

    const labelIndex = labelToIndex.get(xValue) ?? 0;
    values[labelIndex] = toNumericValue(row[spec.yKey]) ?? 0;
  }

  const discoveredSeriesKeys = Array.from(seriesValues.keys());

  const orderedSeriesKeys =
    spec.series && spec.series.length > 0
      ? [
          ...spec.series
            .map((entry) => entry.key)
            .filter((key) => discoveredSeriesKeys.includes(key)),
          ...discoveredSeriesKeys.filter(
            (key) => !spec.series?.some((entry) => entry.key === key)
          ),
        ]
      : discoveredSeriesKeys;

  const series: ChartSeries[] = orderedSeriesKeys.map((seriesKey, index) => {
    const override = spec.series?.find(
      (entry) => entry.key === seriesKey || entry.label === seriesKey
    );

    return {
      key: seriesKey,
      label: override?.label ?? seriesKey,
      color: getColor(index, override?.color),
    };
  });

  if (labels.length === 0 || series.length === 0) {
    return null;
  }

  const rows: CartesianRow[] = labels.map((label, index) => {
    const normalizedRow: CartesianRow = { x: label };

    for (const currentSeries of series) {
      const values = seriesValues.get(currentSeries.key) ?? [];
      normalizedRow[currentSeries.key] = values[index] ?? 0;
    }

    return normalizedRow;
  });

  const { xLabel, yLabel } = getAxisLabels(spec, series);

  return {
    kind: "cartesian",
    chartType: spec.type as CartesianModel["chartType"],
    rows,
    series,
    xLabel,
    yLabel,
    unit: spec.unit,
  };
}

function normalizePie(spec: ChartSpecV1): PieModel {
  if (!spec.nameKey || !spec.valueKey) {
    return { kind: "pie", slices: [] };
  }

  const slices: PieSlice[] = [];

  for (const row of spec.data) {
    const rawName = row[spec.nameKey];
    const rawValue = toNumericValue(row[spec.valueKey]);

    if (rawName === undefined || rawName === null || rawValue === null) {
      continue;
    }

    if (rawValue <= 0) {
      continue;
    }

    const name = String(rawName);
    const override = spec.series?.find(
      (entry) => entry.key === name || entry.label === name
    );

    slices.push({
      key: name,
      name,
      value: rawValue,
      color: getColor(slices.length, override?.color),
    });
  }

  return { kind: "pie", slices };
}

function buildChartModel(spec: ChartSpecV1): ChartModel | null {
  if (spec.type === "pie") {
    return normalizePie(spec);
  }

  if (spec.seriesKey && spec.yKey) {
    return normalizeLongCartesian(spec);
  }

  return normalizeWideCartesian(spec);
}

function ChartWarning({ text }: { text: string }) {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-amber-900 text-sm dark:border-amber-700/50 dark:bg-amber-950/40 dark:text-amber-200">
      <TriangleAlert className="mt-0.5 size-4 shrink-0" />
      <span>{text}</span>
    </div>
  );
}

function CustomTooltip({
  active,
  payload,
  label,
  unit,
}: {
  active?: boolean;
  payload?: Array<{ color?: string; name?: string; value?: unknown }>;
  label?: string | number;
  unit?: string;
}) {
  if (!active || !payload || payload.length === 0) {
    return null;
  }

  return (
    <div className="rounded-md border bg-background px-3 py-2 shadow-md">
      {label !== undefined && (
        <div className="mb-1 font-medium text-xs">{String(label)}</div>
      )}

      <div className="space-y-1 text-xs">
        {payload.map((item, index) => (
          <div
            className="flex items-center gap-2"
            key={`${item.name}-${index}`}
          >
            <span
              className="inline-block size-2.5 rounded-sm"
              style={{ backgroundColor: item.color ?? "#64748b" }}
            />
            <span className="text-muted-foreground">
              {item.name ?? "Serie"}:
            </span>
            <span className="font-medium">
              {formatTooltipValue(item.value, unit)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function SeriesLegend({
  items,
  hidden,
  onToggle,
}: {
  items: Array<{ key: string; label: string; color: string }>;
  hidden: Record<string, boolean>;
  onToggle: (key: string) => void;
}) {
  if (items.length === 0) {
    return null;
  }

  return (
    <div className="mt-1 flex flex-wrap gap-2">
      {items.map((item) => {
        const isHidden = hidden[item.key] === true;

        return (
          <button
            className={cn(
              "inline-flex items-center gap-2 rounded-md border px-2 py-1 text-xs transition",
              isHidden
                ? "border-muted-foreground/30 text-muted-foreground"
                : "border-border text-foreground"
            )}
            key={item.key}
            onClick={() => onToggle(item.key)}
            type="button"
          >
            <span
              className="inline-block size-2.5 rounded-sm"
              style={{
                backgroundColor: item.color,
                opacity: isHidden ? 0.35 : 1,
              }}
            />
            <span className={isHidden ? "line-through" : ""}>
              {truncateLabel(item.label, 32)}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function ChartViewport({
  model,
  expanded,
  hiddenSeries,
  onToggleSeries,
  zoomRange,
  onZoomRangeChange,
  chartContainerRef,
}: {
  model: ChartModel;
  expanded?: boolean;
  hiddenSeries: Record<string, boolean>;
  onToggleSeries: (key: string) => void;
  zoomRange: ZoomRange | null;
  onZoomRangeChange: (range: ZoomRange | null) => void;
  chartContainerRef: Ref<HTMLDivElement>;
}) {
  if (model.kind === "pie") {
    const visibleSlices = model.slices.filter(
      (slice) => hiddenSeries[slice.key] !== true
    );

    if (model.slices.length === 0) {
      return (
        <div className="rounded-md border border-dashed px-3 py-4 text-muted-foreground text-sm">
          Dados insuficientes para renderizar o grafico de pizza.
        </div>
      );
    }

    if (visibleSlices.length === 0) {
      return (
        <div className="rounded-md border border-dashed px-3 py-4 text-muted-foreground text-sm">
          Ative ao menos uma serie na legenda para exibir o grafico.
        </div>
      );
    }

    const total = visibleSlices.reduce((sum, slice) => sum + slice.value, 0);

    return (
      <div ref={chartContainerRef}>
        <div className={cn("h-[340px] w-full", expanded && "h-[520px]")}>
          <ResponsiveContainer height="100%" width="100%">
            <PieChart margin={{ top: 16, right: 16, bottom: 16, left: 16 }}>
              <Tooltip
                content={<CustomTooltip payload={undefined} unit={undefined} />}
              />
              <Pie
                animationDuration={500}
                data={visibleSlices}
                dataKey="value"
                innerRadius={expanded ? 100 : 72}
                isAnimationActive={true}
                nameKey="name"
                outerRadius={expanded ? 170 : 130}
                paddingAngle={2}
              >
                {visibleSlices.map((slice) => (
                  <Cell fill={slice.color} key={slice.key} />
                ))}
              </Pie>
            </PieChart>
          </ResponsiveContainer>
        </div>

        <div className="mb-1 text-muted-foreground text-xs">
          Total: {formatNumber(total)}
        </div>

        <SeriesLegend
          hidden={hiddenSeries}
          items={model.slices.map((slice) => ({
            key: slice.key,
            label: slice.name,
            color: slice.color,
          }))}
          onToggle={onToggleSeries}
        />
      </div>
    );
  }

  const visibleSeries = model.series.filter(
    (series) => hiddenSeries[series.key] !== true
  );

  if (model.rows.length === 0 || model.series.length === 0) {
    return (
      <div className="rounded-md border border-dashed px-3 py-4 text-muted-foreground text-sm">
        Dados insuficientes para renderizar o grafico.
      </div>
    );
  }

  if (visibleSeries.length === 0) {
    return (
      <div className="rounded-md border border-dashed px-3 py-4 text-muted-foreground text-sm">
        Ative ao menos uma serie na legenda para exibir o grafico.
      </div>
    );
  }

  return (
    <div ref={chartContainerRef}>
      <div className={cn("h-[340px] w-full", expanded && "h-[520px]")}>
        <ResponsiveContainer height="100%" width="100%">
          {model.chartType === "bar" ? (
            <BarChart
              data={model.rows}
              margin={{ top: 16, right: 16, bottom: 24, left: 16 }}
            >
              <CartesianGrid
                opacity={0.35}
                strokeDasharray="4 4"
                vertical={false}
              />
              <XAxis
                axisLine={true}
                dataKey="x"
                height={48}
                interval="preserveStartEnd"
                label={{
                  value: truncateLabel(model.xLabel, expanded ? 68 : 44),
                  position: "insideBottom",
                  offset: -2,
                  style: { fontSize: 12, fontWeight: 600 },
                }}
                minTickGap={14}
                tick={{ fontSize: 11 }}
                tickLine={false}
                tickMargin={5}
              />
              <YAxis
                axisLine={false}
                label={{
                  value: truncateLabel(model.yLabel, expanded ? 68 : 44),
                  angle: -90,
                  position: "insideLeft",
                  style: {
                    textAnchor: "middle",
                    fontSize: 12,
                    fontWeight: 600,
                  },
                }}
                tick={{ fontSize: 11 }}
                tickFormatter={(value) =>
                  formatNumber(toNumericValue(value) ?? 0, model.unit)
                }
                tickLine={false}
                width={88}
              />
              <Tooltip content={<CustomTooltip unit={model.unit} />} />

              {visibleSeries.map((series) => (
                <Bar
                  animationDuration={520}
                  dataKey={series.key}
                  fill={series.color}
                  isAnimationActive={true}
                  key={series.key}
                  name={series.label}
                  radius={[4, 4, 0, 0]}
                >
                  <LabelList
                    dataKey={series.key}
                    fill="#475569"
                    fontSize={10}
                    formatter={(value: unknown) => formatBarLabel(value)}
                    position="top"
                  />
                </Bar>
              ))}

            </BarChart>
          ) : model.chartType === "line" ? (
            <LineChart
              data={model.rows}
              margin={{ top: 16, right: 16, bottom: 24, left: 16 }}
            >
              <CartesianGrid
                opacity={0.35}
                strokeDasharray="4 4"
                vertical={false}
              />
              <XAxis
                axisLine={true}
                dataKey="x"
                height={48}
                interval="preserveStartEnd"
                label={{
                  value: truncateLabel(model.xLabel, expanded ? 68 : 44),
                  position: "insideBottom",
                  offset: -2,
                  style: { fontSize: 12, fontWeight: 600 },
                }}
                minTickGap={14}
                tick={{ fontSize: 11 }}
                tickLine={false}
                tickMargin={5}
              />
              <YAxis
                axisLine={false}
                label={{
                  value: truncateLabel(model.yLabel, expanded ? 68 : 44),
                  angle: -90,
                  position: "insideLeft",
                  style: {
                    textAnchor: "middle",
                    fontSize: 12,
                    fontWeight: 600,
                  },
                }}
                tick={{ fontSize: 11 }}
                tickFormatter={(value) =>
                  formatNumber(toNumericValue(value) ?? 0, model.unit)
                }
                tickLine={false}
                width={88}
              />
              <Tooltip content={<CustomTooltip unit={model.unit} />} />

              {visibleSeries.map((series) => (
                <Line
                  animationDuration={520}
                  dataKey={series.key}
                  dot={{ r: 2.5 }}
                  isAnimationActive={true}
                  key={series.key}
                  name={series.label}
                  stroke={series.color}
                  strokeWidth={2.2}
                  type="monotone"
                />
              ))}

            </LineChart>
          ) : (
            <AreaChart
              data={model.rows}
              margin={{ top: 16, right: 16, bottom: 24, left: 16 }}
            >
              <CartesianGrid
                opacity={0.35}
                strokeDasharray="4 4"
                vertical={false}
              />
              <XAxis
                axisLine={true}
                dataKey="x"
                height={48}
                interval="preserveStartEnd"
                label={{
                  value: truncateLabel(model.xLabel, expanded ? 68 : 44),
                  position: "insideBottom",
                  offset: -2,
                  style: { fontSize: 12, fontWeight: 600 },
                }}
                minTickGap={14}
                tick={{ fontSize: 11 }}
                tickLine={false}
                tickMargin={5}
              />
              <YAxis
                axisLine={false}
                label={{
                  value: truncateLabel(model.yLabel, expanded ? 68 : 44),
                  angle: -90,
                  position: "insideLeft",
                  style: {
                    textAnchor: "middle",
                    fontSize: 12,
                    fontWeight: 600,
                  },
                }}
                tick={{ fontSize: 11 }}
                tickFormatter={(value) =>
                  formatNumber(toNumericValue(value) ?? 0, model.unit)
                }
                tickLine={false}
                width={88}
              />
              <Tooltip content={<CustomTooltip unit={model.unit} />} />

              {visibleSeries.map((series) => (
                <Area
                  animationDuration={520}
                  dataKey={series.key}
                  fill={series.color}
                  fillOpacity={0.22}
                  isAnimationActive={true}
                  key={series.key}
                  name={series.label}
                  stroke={series.color}
                  strokeWidth={2}
                  type="monotone"
                />
              ))}

            </AreaChart>
          )}
        </ResponsiveContainer>
      </div>

      <SeriesLegend
        hidden={hiddenSeries}
        items={model.series.map((series) => ({
          key: series.key,
          label: series.label,
          color: series.color,
        }))}
        onToggle={onToggleSeries}
      />
    </div>
  );
}

export function ChartRenderer({
  chartSpec,
  chartWarning,
  className,
}: ChartRendererProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [isCopied, setIsCopied] = useState(false);
  const [hiddenSeries, setHiddenSeries] = useState<Record<string, boolean>>({});
  const [zoomRange, setZoomRange] = useState<ZoomRange | null>(null);

  const inlineChartRef = useRef<HTMLDivElement | null>(null);
  const expandedChartRef = useRef<HTMLDivElement | null>(null);

  const parsedSpec = useMemo(
    () => (chartSpec ? chartSpecSchema.safeParse(chartSpec) : null),
    [chartSpec]
  );

  const validSpec = parsedSpec?.success ? parsedSpec.data : null;

  const chartModel = useMemo(() => {
    if (!validSpec) {
      return null;
    }

    return buildChartModel(validSpec);
  }, [validSpec]);

  const modelResetKey = useMemo(
    () => (validSpec ? JSON.stringify(validSpec) : "none"),
    [validSpec]
  );
  const previousModelResetKey = useRef<string | null>(null);

  useEffect(() => {
    if (previousModelResetKey.current === modelResetKey) {
      return;
    }

    previousModelResetKey.current = modelResetKey;
    setHiddenSeries({});
    setZoomRange(null);
  }, [modelResetKey]);

  const parsedWarning =
    parsedSpec && !parsedSpec.success
      ? "Nao foi possivel renderizar o grafico desta resposta."
      : null;

  const resolvedWarning = chartWarning ?? parsedWarning;

  const isZoomed =
    chartModel?.kind === "cartesian" &&
    zoomRange !== null &&
    (zoomRange.startIndex > 0 ||
      zoomRange.endIndex < chartModel.rows.length - 1);

  const handleToggleSeries = (seriesKey: string) => {
    setHiddenSeries((current) => ({
      ...current,
      [seriesKey]: current[seriesKey] !== true,
    }));
  };

  const getExportNode = () => {
    if (isExpanded && expandedChartRef.current) {
      return expandedChartRef.current;
    }

    return inlineChartRef.current;
  };

  const handleDownload = async () => {
    const node = getExportNode();

    if (!node || !validSpec) {
      return;
    }

    try {
      const dataUrl = await toPng(node, EXPORT_OPTIONS);
      const anchor = document.createElement("a");
      const baseName = slugifyTitle(validSpec.title ?? "grafico");

      anchor.href = dataUrl;
      anchor.download = `${baseName || "grafico"}.png`;
      anchor.click();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Falha ao baixar grafico.";
      toast.error(message);
    }
  };

  const handleCopy = async () => {
    const node = getExportNode();

    if (!node) {
      return;
    }

    if (!navigator.clipboard || typeof ClipboardItem === "undefined") {
      toast.error("Copia de imagem nao suportada neste navegador.");
      return;
    }

    try {
      const blob = await toBlob(node, EXPORT_OPTIONS);

      if (!blob) {
        throw new Error("Falha ao gerar imagem do grafico.");
      }

      await navigator.clipboard.write([
        new ClipboardItem({
          [blob.type]: blob,
        }),
      ]);

      setIsCopied(true);
      setTimeout(() => setIsCopied(false), 1300);
      toast.success("Grafico copiado.");
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Falha ao copiar grafico.";
      toast.error(message);
    }
  };

  if (!chartModel && !resolvedWarning) {
    return null;
  }

  return (
    <div className={cn("flex w-full flex-col gap-2", className)}>
      {resolvedWarning && <ChartWarning text={resolvedWarning} />}

      {chartModel && validSpec && (
        <div className="rounded-xl border bg-card p-3 md:p-4">
          <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="truncate font-medium text-sm md:text-base">
                {validSpec.title ?? "Grafico"}
              </div>
              {validSpec.subtitle && (
                <div className="text-muted-foreground text-xs md:text-sm">
                  {validSpec.subtitle}
                </div>
              )}
            </div>

            <div className="flex items-center gap-1">
              {chartModel.kind === "cartesian" && isZoomed && (
                <Button
                  onClick={() => setZoomRange(null)}
                  size="icon-sm"
                  title="Resetar zoom"
                  type="button"
                  variant="ghost"
                >
                  <RotateCcw className="size-4" />
                </Button>
              )}

              <Button
                onClick={() => setIsExpanded(true)}
                size="icon-sm"
                title="Expandir grafico"
                type="button"
                variant="ghost"
              >
                <Maximize2 className="size-4" />
              </Button>
              <Button
                onClick={handleDownload}
                size="icon-sm"
                title="Baixar grafico"
                type="button"
                variant="ghost"
              >
                <Download className="size-4" />
              </Button>
              <Button
                onClick={handleCopy}
                size="icon-sm"
                title={isCopied ? "Copiado" : "Copiar grafico"}
                type="button"
                variant="ghost"
              >
                {isCopied ? (
                  <Check className="size-4" />
                ) : (
                  <Copy className="size-4" />
                )}
              </Button>
            </div>
          </div>

          <ChartViewport
            chartContainerRef={inlineChartRef}
            hiddenSeries={hiddenSeries}
            model={chartModel}
            onToggleSeries={handleToggleSeries}
            onZoomRangeChange={setZoomRange}
            zoomRange={zoomRange}
          />
        </div>
      )}

      {chartModel && validSpec && (
        <Dialog onOpenChange={setIsExpanded} open={isExpanded}>
          <DialogContent className="max-h-[92vh] max-w-[96vw] overflow-hidden p-4 md:max-w-6xl">
            <DialogHeader>
              <DialogTitle>{validSpec.title ?? "Grafico"}</DialogTitle>
              <DialogDescription>
                Visualização expandida do gráfico da resposta.
              </DialogDescription>
            </DialogHeader>

            <div className="overflow-auto pb-2">
              <ChartViewport
                chartContainerRef={expandedChartRef}
                expanded={true}
                hiddenSeries={hiddenSeries}
                model={chartModel}
                onToggleSeries={handleToggleSeries}
                onZoomRangeChange={setZoomRange}
                zoomRange={zoomRange}
              />
            </div>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
