"use client";

import { Check, Copy, Download, Maximize2, TriangleAlert } from "lucide-react";
import { type Ref, useMemo, useRef, useState } from "react";
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

type NormalizedSeries = {
  key: string;
  label: string;
  color: string;
  values: number[];
};

type CartesianData = {
  labels: string[];
  series: NormalizedSeries[];
  maxValue: number;
};

type PieSlice = {
  label: string;
  value: number;
  color: string;
};

const DEFAULT_COLORS = ["#22c55e", "#0ea5e9", "#f97316", "#eab308", "#ef4444"];

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

function formatAxisNumber(value: number, unit?: string) {
  const formatted = value.toLocaleString("pt-BR", {
    maximumFractionDigits: 2,
  });
  return unit ? `${formatted} ${unit}` : formatted;
}

function truncateLabel(value: string, limit = 14) {
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

function getAxisLabels(spec: ChartSpecV1, cartesianData: CartesianData) {
  const xLabel = spec.xLabel ?? (spec.xKey ? humanizeKey(spec.xKey) : "Eixo X");

  const fallbackY = spec.yKey
    ? humanizeKey(spec.yKey)
    : cartesianData.series.length === 1
      ? cartesianData.series[0].label
      : "Valores";

  const yLabelBase = spec.yLabel ?? fallbackY;
  const yLabel = spec.unit ? `${yLabelBase} (${spec.unit})` : yLabelBase;

  return { xLabel, yLabel };
}

function buildWideSeries(spec: ChartSpecV1) {
  if (!spec.xKey) {
    return null;
  }

  const labels = spec.data.map((row, index) => {
    const raw = row[spec.xKey as string];
    if (raw === undefined || raw === null || String(raw).trim() === "") {
      return `Item ${index + 1}`;
    }
    return String(raw);
  });

  const firstRow = spec.data[0] ?? {};
  const inferredKeys = Object.keys(firstRow).filter((key) => {
    if (key === spec.xKey) {
      return false;
    }

    return toNumericValue(firstRow[key]) !== null;
  });

  const selectedSeries: Array<{
    key: string;
    label?: string;
    color?: string;
  }> =
    spec.series && spec.series.length > 0
      ? spec.series
      : inferredKeys.slice(0, 4).map((key) => ({
          key,
          label: key,
          color: undefined,
        }));

  const normalizedSeries: NormalizedSeries[] = selectedSeries.map(
    (series, seriesIndex) => ({
      key: series.key,
      label: series.label ?? series.key,
      color: getColor(seriesIndex, series.color),
      values: spec.data.map((row) => toNumericValue(row[series.key]) ?? 0),
    })
  );

  const maxValue = normalizedSeries.reduce((max, currentSeries) => {
    const seriesMax = Math.max(...currentSeries.values, 0);
    return Math.max(max, seriesMax);
  }, 0);

  return {
    labels,
    series: normalizedSeries,
    maxValue,
  };
}

function buildLongSeries(spec: ChartSpecV1) {
  if (!spec.xKey || !spec.seriesKey || !spec.yKey) {
    return null;
  }

  const labelOrder: string[] = [];
  const labelIndex = new Map<string, number>();
  const seriesMap = new Map<string, NormalizedSeries>();

  for (const row of spec.data) {
    const xValue = row[spec.xKey];
    const seriesValue = row[spec.seriesKey];
    const yValue = toNumericValue(row[spec.yKey]);

    if (xValue === undefined || xValue === null || yValue === null) {
      continue;
    }

    const label = String(xValue);
    if (!labelIndex.has(label)) {
      labelIndex.set(label, labelOrder.length);
      labelOrder.push(label);
    }

    const seriesLabel = String(seriesValue ?? "Serie");
    const existing = seriesMap.get(seriesLabel);

    if (existing) {
      existing.values[labelIndex.get(label) ?? 0] = yValue;
      continue;
    }

    const override = spec.series?.find(
      (series) => series.key === seriesLabel || series.label === seriesLabel
    );
    const nextSeries: NormalizedSeries = {
      key: seriesLabel,
      label: override?.label ?? seriesLabel,
      color: getColor(seriesMap.size, override?.color),
      values: new Array(labelOrder.length).fill(0),
    };
    nextSeries.values[labelIndex.get(label) ?? 0] = yValue;
    seriesMap.set(seriesLabel, nextSeries);
  }

  const normalizedSeries = Array.from(seriesMap.values()).map((series) => {
    if (series.values.length < labelOrder.length) {
      const filled = [...series.values];
      while (filled.length < labelOrder.length) {
        filled.push(0);
      }
      return { ...series, values: filled };
    }
    return series;
  });

  const maxValue = normalizedSeries.reduce((max, currentSeries) => {
    const seriesMax = Math.max(...currentSeries.values, 0);
    return Math.max(max, seriesMax);
  }, 0);

  return {
    labels: labelOrder,
    series: normalizedSeries,
    maxValue,
  };
}

function getCartesianData(spec: ChartSpecV1): CartesianData | null {
  const longData =
    spec.seriesKey && spec.yKey ? buildLongSeries(spec) : buildWideSeries(spec);

  if (
    !longData ||
    longData.labels.length === 0 ||
    longData.series.length === 0
  ) {
    return null;
  }

  return {
    labels: longData.labels,
    series: longData.series,
    maxValue: Math.max(1, longData.maxValue * 1.1),
  };
}

function getPieData(spec: ChartSpecV1): PieSlice[] {
  if (!spec.nameKey || !spec.valueKey) {
    return [];
  }

  const slices: PieSlice[] = [];

  for (const row of spec.data) {
    const labelValue = row[spec.nameKey];
    const value = toNumericValue(row[spec.valueKey]);

    if (labelValue === undefined || labelValue === null || value === null) {
      continue;
    }

    if (value <= 0) {
      continue;
    }

    slices.push({
      label: String(labelValue),
      value,
      color: getColor(slices.length),
    });
  }

  return slices;
}

function toArcPath(
  cx: number,
  cy: number,
  radius: number,
  startAngle: number,
  endAngle: number
) {
  const startX = cx + radius * Math.cos(startAngle);
  const startY = cy + radius * Math.sin(startAngle);
  const endX = cx + radius * Math.cos(endAngle);
  const endY = cy + radius * Math.sin(endAngle);
  const largeArc = endAngle - startAngle > Math.PI ? 1 : 0;

  return [
    `M ${cx} ${cy}`,
    `L ${startX} ${startY}`,
    `A ${radius} ${radius} 0 ${largeArc} 1 ${endX} ${endY}`,
    "Z",
  ].join(" ");
}

async function svgToPngBlob(svg: SVGSVGElement): Promise<Blob> {
  const serializer = new XMLSerializer();

  const clone = svg.cloneNode(true) as SVGSVGElement;
  const originalElements = [svg, ...Array.from(svg.querySelectorAll("*"))];
  const clonedElements = [clone, ...Array.from(clone.querySelectorAll("*"))];
  const resolvableAttributes = ["fill", "stroke", "color"] as const;

  for (let index = 0; index < clonedElements.length; index += 1) {
    const clonedElement = clonedElements[index];
    const originalElement = originalElements[index];

    if (!clonedElement || !originalElement) {
      continue;
    }

    const computedStyle = getComputedStyle(originalElement);

    for (const attributeName of resolvableAttributes) {
      const currentValue = clonedElement.getAttribute(attributeName);
      if (!currentValue) {
        continue;
      }

      if (!currentValue.includes("var(") && currentValue !== "currentColor") {
        continue;
      }

      const resolved = computedStyle.getPropertyValue(attributeName).trim();
      if (resolved) {
        clonedElement.setAttribute(attributeName, resolved);
      }
    }
  }

  const rawSvg = serializer.serializeToString(clone);
  const svgWithNamespace = rawSvg.includes("xmlns=")
    ? rawSvg
    : rawSvg.replace("<svg", '<svg xmlns="http://www.w3.org/2000/svg"');

  const svgBlob = new Blob([svgWithNamespace], {
    type: "image/svg+xml;charset=utf-8",
  });
  const svgUrl = URL.createObjectURL(svgBlob);

  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const chartImage = new Image();
      chartImage.onload = () => resolve(chartImage);
      chartImage.onerror = () => reject(new Error("Falha ao carregar SVG"));
      chartImage.src = svgUrl;
    });

    const viewBox = svg.viewBox.baseVal;
    const width = Math.max(
      1,
      Math.round(viewBox.width || svg.clientWidth || 800)
    );
    const height = Math.max(
      1,
      Math.round(viewBox.height || svg.clientHeight || 360)
    );

    const canvas = document.createElement("canvas");
    canvas.width = width * 2;
    canvas.height = height * 2;

    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error("Falha ao obter contexto 2D");
    }

    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);

    const pngBlob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (!blob) {
          reject(new Error("Falha ao converter grafico para PNG"));
          return;
        }
        resolve(blob);
      }, "image/png");
    });

    return pngBlob;
  } finally {
    URL.revokeObjectURL(svgUrl);
  }
}

function ChartWarning({ text }: { text: string }) {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-amber-900 text-sm dark:border-amber-700/50 dark:bg-amber-950/40 dark:text-amber-200">
      <TriangleAlert className="mt-0.5 size-4 shrink-0" />
      <span>{text}</span>
    </div>
  );
}

function ChartSvg({
  spec,
  svgRef,
  expanded,
}: {
  spec: ChartSpecV1;
  svgRef: Ref<SVGSVGElement>;
  expanded?: boolean;
}) {
  if (spec.type === "pie") {
    const pieData = getPieData(spec);

    if (pieData.length === 0) {
      return (
        <div className="rounded-md border border-dashed px-3 py-4 text-muted-foreground text-sm">
          Dados insuficientes para renderizar o grafico de pizza.
        </div>
      );
    }

    const width = expanded ? 940 : 760;
    const height = expanded ? 520 : 380;
    const centerX = expanded ? 320 : 260;
    const centerY = height / 2;
    const radius = expanded ? 150 : 120;
    const total = pieData.reduce((sum, item) => sum + item.value, 0);

    let currentAngle = -Math.PI / 2;

    return (
      <div className="overflow-x-auto">
        <svg
          className="mx-auto"
          height={height}
          ref={svgRef}
          viewBox={`0 0 ${width} ${height}`}
          width={width}
        >
          {pieData.map((slice) => {
            const sliceAngle = (slice.value / total) * Math.PI * 2;
            const start = currentAngle;
            const end = currentAngle + sliceAngle;
            const path = toArcPath(centerX, centerY, radius, start, end);
            currentAngle = end;

            return (
              <path
                d={path}
                fill={slice.color}
                key={`${slice.label}-${slice.value}`}
                stroke="var(--color-background)"
                strokeWidth={1}
              />
            );
          })}

          <circle
            cx={centerX}
            cy={centerY}
            fill="var(--color-background)"
            opacity={0.95}
            r={radius * 0.45}
          />
          <text
            fill="currentColor"
            fontSize={expanded ? 18 : 16}
            fontWeight={700}
            textAnchor="middle"
            x={centerX}
            y={centerY - 6}
          >
            {total.toLocaleString("pt-BR", { maximumFractionDigits: 2 })}
          </text>
          <text
            fill="currentColor"
            fontSize={expanded ? 13 : 12}
            opacity={0.7}
            textAnchor="middle"
            x={centerX}
            y={centerY + 14}
          >
            Total
          </text>

          <g
            transform={`translate(${expanded ? 560 : 450}, ${expanded ? 120 : 90})`}
          >
            {pieData.map((slice, index) => {
              const percentage = ((slice.value / total) * 100).toLocaleString(
                "pt-BR",
                { maximumFractionDigits: 1 }
              );
              return (
                <g
                  key={`${slice.label}-${index}`}
                  transform={`translate(0 ${index * 30})`}
                >
                  <rect
                    fill={slice.color}
                    height={12}
                    rx={2}
                    width={12}
                    x={0}
                    y={2}
                  />
                  <text fill="currentColor" fontSize={12} x={20} y={12}>
                    {truncateLabel(slice.label, expanded ? 30 : 22)} (
                    {percentage}%)
                  </text>
                </g>
              );
            })}
          </g>
        </svg>
      </div>
    );
  }

  const cartesianData = getCartesianData(spec);

  if (!cartesianData) {
    return (
      <div className="rounded-md border border-dashed px-3 py-4 text-muted-foreground text-sm">
        Dados insuficientes para renderizar o grafico.
      </div>
    );
  }

  const pointCount = cartesianData.labels.length;
  const width = Math.max(expanded ? 940 : 720, 160 + pointCount * 72);
  const height = expanded ? 520 : 360;
  const margin = { top: 18, right: 22, bottom: 84, left: 68 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const yTickCount = 5;
  const yTicks = Array.from({ length: yTickCount + 1 }, (_, index) => {
    const ratio = index / yTickCount;
    return cartesianData.maxValue * ratio;
  });
  const labelStep = Math.max(1, Math.ceil(pointCount / 12));
  const xSlot = plotWidth / Math.max(1, pointCount);
  const xAxisLabels: Array<{ key: string; label: string; pointIndex: number }> =
    [];
  const labelOccurrences = new Map<string, number>();

  for (
    let pointIndex = 0;
    pointIndex < cartesianData.labels.length;
    pointIndex += 1
  ) {
    const label = cartesianData.labels[pointIndex];
    const nextOccurrence = (labelOccurrences.get(label) ?? 0) + 1;
    labelOccurrences.set(label, nextOccurrence);
    xAxisLabels.push({
      key: `${label}-${nextOccurrence}`,
      label,
      pointIndex,
    });
  }

  const mapX = (index: number) => margin.left + xSlot * index + xSlot / 2;
  const mapY = (value: number) =>
    margin.top + plotHeight - (value / cartesianData.maxValue) * plotHeight;
  const { xLabel, yLabel } = getAxisLabels(spec, cartesianData);

  return (
    <div className="overflow-x-auto">
      <svg
        className="mx-auto"
        height={height}
        ref={svgRef}
        viewBox={`0 0 ${width} ${height}`}
        width={width}
      >
        {yTicks.map((tick) => {
          const y = mapY(tick);
          return (
            <g key={`y-${tick.toFixed(4)}`}>
              <line
                opacity={0.2}
                stroke="currentColor"
                strokeDasharray="4 4"
                x1={margin.left}
                x2={width - margin.right}
                y1={y}
                y2={y}
              />
              <text
                fill="currentColor"
                fontSize={11}
                opacity={0.7}
                textAnchor="end"
                x={margin.left - 8}
                y={y + 4}
              >
                {formatAxisNumber(tick, spec.unit)}
              </text>
            </g>
          );
        })}

        <line
          stroke="currentColor"
          strokeWidth={1.2}
          x1={margin.left}
          x2={margin.left}
          y1={margin.top}
          y2={height - margin.bottom}
        />
        <line
          stroke="currentColor"
          strokeWidth={1.2}
          x1={margin.left}
          x2={width - margin.right}
          y1={height - margin.bottom}
          y2={height - margin.bottom}
        />

        {spec.type === "bar" &&
          cartesianData.series.map((series, seriesIndex) => {
            const groupWidth = xSlot * 0.72;
            const barWidth = Math.max(
              8,
              Math.min(34, groupWidth / cartesianData.series.length)
            );
            return series.values.map((value, pointIndex) => {
              const xBase = mapX(pointIndex) - groupWidth / 2;
              const x = xBase + seriesIndex * barWidth;
              const y = mapY(value);
              const barHeight = height - margin.bottom - y;

              return (
                <rect
                  fill={series.color}
                  height={Math.max(0, barHeight)}
                  key={`${series.key}-${pointIndex}`}
                  opacity={0.9}
                  rx={2}
                  width={barWidth - 2}
                  x={x}
                  y={y}
                />
              );
            });
          })}

        {(spec.type === "line" || spec.type === "area") &&
          cartesianData.series.map((series) => {
            const points = series.values.map((value, index) => ({
              x: mapX(index),
              y: mapY(value),
            }));

            const linePath = points
              .map(
                (point, index) =>
                  `${index === 0 ? "M" : "L"} ${point.x} ${point.y}`
              )
              .join(" ");

            const areaPath = [
              linePath,
              `L ${points.at(-1)?.x ?? margin.left} ${height - margin.bottom}`,
              `L ${points[0]?.x ?? margin.left} ${height - margin.bottom}`,
              "Z",
            ].join(" ");

            return (
              <g key={series.key}>
                {spec.type === "area" && (
                  <path d={areaPath} fill={series.color} opacity={0.2} />
                )}
                <path
                  d={linePath}
                  fill="none"
                  stroke={series.color}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2.5}
                />
                {points.map((point, index) => (
                  <circle
                    cx={point.x}
                    cy={point.y}
                    fill={series.color}
                    key={`${series.key}-point-${index}`}
                    r={3.2}
                  />
                ))}
              </g>
            );
          })}

        {xAxisLabels.map(({ key, label, pointIndex }) => {
          if (pointIndex % labelStep !== 0) {
            return null;
          }

          return (
            <text
              fill="currentColor"
              fontSize={11}
              key={key}
              opacity={0.8}
              textAnchor="middle"
              x={mapX(pointIndex)}
              y={height - margin.bottom + 16}
            >
              {truncateLabel(label)}
            </text>
          );
        })}

        <g transform={`translate(${margin.left}, ${height - 36})`}>
          {cartesianData.series.map((series, index) => (
            <g key={series.key} transform={`translate(${index * 170}, 0)`}>
              <rect
                fill={series.color}
                height={10}
                rx={2}
                width={10}
                x={0}
                y={0}
              />
              <text fill="currentColor" fontSize={12} x={16} y={9}>
                {truncateLabel(series.label, 24)}
              </text>
            </g>
          ))}
        </g>

        <text
          fill="currentColor"
          fontSize={12}
          fontWeight={600}
          opacity={0.85}
          textAnchor="middle"
          x={(margin.left + (width - margin.right)) / 2}
          y={height - 10}
        >
          {truncateLabel(xLabel, expanded ? 64 : 44)}
        </text>
        <text
          fill="currentColor"
          fontSize={12}
          fontWeight={600}
          opacity={0.85}
          textAnchor="middle"
          transform={`translate(${expanded ? 20 : 18}, ${(margin.top + (height - margin.bottom)) / 2}) rotate(-90)`}
        >
          {truncateLabel(yLabel, expanded ? 64 : 40)}
        </text>
      </svg>
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
  const inlineSvgRef = useRef<SVGSVGElement | null>(null);
  const expandedSvgRef = useRef<SVGSVGElement | null>(null);

  const parsedSpec = useMemo(
    () => (chartSpec ? chartSpecSchema.safeParse(chartSpec) : null),
    [chartSpec]
  );

  const validSpec = parsedSpec?.success ? parsedSpec.data : null;
  const parsedWarning =
    parsedSpec && !parsedSpec.success
      ? "Nao foi possivel renderizar o grafico desta resposta."
      : null;
  const resolvedWarning = chartWarning ?? parsedWarning;

  const handleDownload = async () => {
    const svg = expandedSvgRef.current ?? inlineSvgRef.current;
    if (!svg || !validSpec) {
      return;
    }

    try {
      const pngBlob = await svgToPngBlob(svg);
      const url = URL.createObjectURL(pngBlob);
      const anchor = document.createElement("a");
      const baseName = slugifyTitle(validSpec.title ?? "grafico");

      anchor.href = url;
      anchor.download = `${baseName || "grafico"}.png`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Falha ao baixar grafico.";
      toast.error(message);
    }
  };

  const handleCopy = async () => {
    const svg = expandedSvgRef.current ?? inlineSvgRef.current;
    if (!svg) {
      return;
    }

    if (!navigator.clipboard || typeof ClipboardItem === "undefined") {
      toast.error("Copia de imagem nao suportada neste navegador.");
      return;
    }

    try {
      const pngBlob = await svgToPngBlob(svg);
      await navigator.clipboard.write([
        new ClipboardItem({
          [pngBlob.type]: pngBlob,
        }),
      ]);
      setIsCopied(true);
      setTimeout(() => setIsCopied(false), 1300);
      toast.success("Gráfico copiado.");
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Falha ao copiar gráfico.";
      toast.error(message);
    }
  };

  if (!validSpec && !resolvedWarning) {
    return null;
  }

  return (
    <div className={cn("flex w-full flex-col gap-2", className)}>
      {resolvedWarning && <ChartWarning text={resolvedWarning} />}

      {validSpec && (
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

          <ChartSvg spec={validSpec} svgRef={inlineSvgRef} />
        </div>
      )}

      {validSpec && (
        <Dialog onOpenChange={setIsExpanded} open={isExpanded}>
          <DialogContent className="max-h-[92vh] max-w-[96vw] overflow-hidden p-4 md:max-w-6xl">
            <DialogHeader>
              <DialogTitle>{validSpec.title ?? "Grafico"}</DialogTitle>
              <DialogDescription>
                Visualizacao expandida do grafico da resposta.
              </DialogDescription>
            </DialogHeader>

            <div className="overflow-auto pb-2">
              <ChartSvg
                expanded={true}
                spec={validSpec}
                svgRef={expandedSvgRef}
              />
            </div>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
