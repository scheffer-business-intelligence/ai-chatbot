import { z } from "zod";

export const chartTypeSchema = z.enum(["bar", "line", "area", "pie"]);

export const chartSeriesSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1).optional(),
  color: z
    .string()
    .regex(/^#(?:[0-9a-fA-F]{3}){1,2}$/)
    .optional(),
});

export const chartSpecSchema = z
  .object({
    version: z.literal("1.0").optional().default("1.0"),
    type: chartTypeSchema,
    title: z.string().min(1).max(120).optional(),
    subtitle: z.string().min(1).max(220).optional(),
    data: z.array(z.record(z.string(), z.unknown())).min(1).max(50),
    xKey: z.string().min(1).optional(),
    yKey: z.string().min(1).optional(),
    seriesKey: z.string().min(1).optional(),
    series: z.array(chartSeriesSchema).min(1).max(12).optional(),
    valueKey: z.string().min(1).optional(),
    nameKey: z.string().min(1).optional(),
    xLabel: z.string().min(1).max(80).optional(),
    yLabel: z.string().min(1).max(80).optional(),
    unit: z.string().min(1).max(24).optional(),
  })
  .superRefine((value, context) => {
    if (value.type === "pie") {
      if (!value.nameKey) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Pie chart requires nameKey.",
          path: ["nameKey"],
        });
      }
      if (!value.valueKey) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Pie chart requires valueKey.",
          path: ["valueKey"],
        });
      }
      return;
    }

    if (!value.xKey) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Chart requires xKey.",
        path: ["xKey"],
      });
    }

    const hasLongFormat = Boolean(value.seriesKey && value.yKey);
    const hasWideFormat = Boolean(value.series && value.series.length > 0);

    if (!hasLongFormat && !hasWideFormat) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Chart requires either series[] or (seriesKey + yKey).",
        path: ["series"],
      });
    }
  });

export type ChartType = z.infer<typeof chartTypeSchema>;
export type ChartSeries = z.infer<typeof chartSeriesSchema>;
export type ChartSpecV1 = z.infer<typeof chartSpecSchema>;
