import { z } from "zod";
import {
  type AgentEngineErrorReasonCode,
  type AgentEngineErrorStage,
} from "./error-envelope";

const reasonCodeValues: [AgentEngineErrorReasonCode, ...AgentEngineErrorReasonCode[]] =
  [
    "empty_vertex_response",
    "vertex_http_error",
    "vertex_connect_error",
    "vertex_invalid_session",
    "stream_parse_error",
    "unknown_agent_engine_error",
  ];

const stageValues: [AgentEngineErrorStage, ...AgentEngineErrorStage[]] = [
  "request_setup",
  "stream_open",
  "stream_runtime",
  "post_stream_empty",
  "session_recovery",
  "unknown",
];

export const agentEngineErrorAnalysisRequestSchema = z.object({
  requestId: z.string().min(1).max(120),
  reasonCode: z.enum(reasonCodeValues),
  reasonLabel: z.string().min(1).max(180),
  message: z.string().min(1).max(2000),
  modelId: z.string().min(1).max(120),
  sessionId: z.string().max(240).nullable().optional(),
  stage: z.enum(stageValues),
  timestamp: z.string().min(1).max(64),
});

export const agentEngineErrorAnalysisSchema = z.object({
  diagnosisSummary: z.string().min(1).max(1200),
  likelyCauses: z.array(z.string().min(1).max(400)).min(1).max(8),
  recommendedActions: z.array(z.string().min(1).max(500)).min(1).max(10),
  checksToRun: z.array(z.string().min(1).max(260)).min(1).max(10),
  confidence: z.enum(["low", "medium", "high"]),
});

export const agentEngineErrorAnalysisResponseSchema = z.object({
  model: z.string().min(1).max(120),
  analysis: agentEngineErrorAnalysisSchema,
});

export type AgentEngineErrorAnalysisRequest = z.infer<
  typeof agentEngineErrorAnalysisRequestSchema
>;
export type AgentEngineErrorAnalysis = z.infer<
  typeof agentEngineErrorAnalysisSchema
>;
export type AgentEngineErrorAnalysisResponse = z.infer<
  typeof agentEngineErrorAnalysisResponseSchema
>;
