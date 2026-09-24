import type { ProductRecord, TechnicalCheck } from "@mclab/shopify-online-store";

import type { ArtifactLinks } from "./components/TechnicalReport";

export type CollectionResult = {
  collection_id: string;
  record: ProductRecord;
  technical_check: TechnicalCheck;
  artifact_links: ArtifactLinks;
};

export type CreditBalance = {
  settled_credits: number;
  reserved_credits: number;
  available_credits: number;
};

export type AccountAccessState = {
  status: "guest" | "connected";
  email_hint: string | null;
};

export type FreeCheckState = {
  enabled: boolean;
  signup_available: boolean;
  granted: boolean;
  remaining: 0 | 1;
};

export type ReportHistoryItem = {
  task_id: string;
  status: string;
  billing_status: string | null;
  created_at: string;
  completed_at: string | null;
};

export type ApiError = { code?: string; message?: string };

export type CustomerTask = {
  id: string;
  job_status: string;
  billing_status: "reserved" | "consumed" | "released";
  progress_stage?: string | null;
  balance: CreditBalance;
  session: {
    status: string;
    report?: {
      status: "complete" | "partial";
      interruption?: { stage: string; explanation: string } | null;
      direct_retrieval?: { status: string; question?: string; answer?: string; explanation?: string; sources?: Array<{ source_id: string; url: string; title: string | null }> };
      disclaimer: string;
      summary: Record<string, number | null>;
      diagnosis?: ReportDiagnosis;
      buyer_situation?: { category: string; job: string; market: string; constraints: string[]; preferences: string[] };
      termination?: { reason?: string; action?: string } | null;
      turns: Array<{
        ordinal: number;
        stage: string;
        adaptive_decision?: { action: string; reason: string } | null;
        shopper_message: string | null;
        shopping_answer: string | null;
        target_observation: Record<string, string> | null;
        sources: Array<{ source_id: string; url: string; title: string | null }>;
        source_groups?: Array<{ label: string; url: string; urls?: string[]; count: number }>;
      }>;
    };
  };
};

export type ReportDiagnosis = {
  outcome: string;
  outcome_label: string;
  headline: string;
  observed_result: string;
  failure_point: { label: string; explanation: string };
  confidence: { observation: string; cause: string; explanation: string };
  technical_eligibility: { status: string; label: string; explanation: string };
  product_source: {
    title: string;
    url: string | null;
    description_word_count: number;
    description_state: string;
    evidence_label: string;
  };
  next_action: {
    title: string;
    rationale: string;
    evidence_type: string;
    hypothesis: string;
    retest: string;
  };
  evidence_quality: {
    completed_turns: number;
    turns_with_sources: number;
    source_records: number;
    unique_source_domains: number;
    source_domains: string[];
    note: string;
  };
  candidate_path_interpretation: string;
  candidate_path: Array<{
    turn: number;
    stage: string;
    action?: string | null;
    reason?: string | null;
    target_state: string;
    entry_status: "entry_observation" | "closed_candidate_set";
    leading_candidates: string[];
    source_domains: string[];
  }>;
  limitations: string[];
};

export type DiagnosticReportData = NonNullable<CustomerTask["session"]["report"]>;
export type DiagnosticTurn = DiagnosticReportData["turns"][number];
