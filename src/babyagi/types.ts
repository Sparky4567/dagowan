export interface FunctionMetadata {
  name: string;
  code: string;
  description?: string;
  imports?: string[];
  dependencies?: string[];
  key_dependencies?: string[];
  version: number;
  metadata?: Record<string, any>;
  created_at: string;
  updated_at: string;
  is_active: boolean;
}

export interface FunctionVersion {
  id?: number;
  function_name: string;
  version: number;
  code: string;
  imports?: string[];
  dependencies?: string[];
  key_dependencies?: string[];
  metadata?: Record<string, any>;
  created_at: string;
  is_active: boolean;
}

export interface ExecutionLog {
  log_id: string;
  function_name: string;
  version: number;
  input_args: any[];
  input_kwargs?: Record<string, any>;
  output_result: any;
  error: string | null;
  execution_time_ms: number;
  timestamp: string;
  parent_log_id: string | null;
}

export interface RegisterFunctionOptions {
  name?: string;
  func?: Function;
  code?: string;
  description?: string;
  imports?: string[];
  dependencies?: string[];
  key_dependencies?: string[];
  metadata?: Record<string, any>;
  version?: number;
}

export interface VectorDocument {
  id: string;
  text: string;
  embedding: number[];
  metadata?: Record<string, any>;
  created_at?: string;
}

export interface TaskItem {
  task_id: number;
  task_name: string;
  result?: string;
  status?: 'pending' | 'in_progress' | 'completed';
}

export interface ClassicBabyAGIConfig {
  objective: string;
  initialTask?: string;
  maxIterations?: number;
  onTaskStart?: (task: TaskItem) => void;
  onTaskComplete?: (task: TaskItem, result: string) => void;
  onTaskCreated?: (tasks: TaskItem[]) => void;
  onPrioritized?: (tasks: TaskItem[]) => void;
}

export interface BabyAGIConfig {
  dbPath?: string;
  port?: number;
  dashboardRoute?: string;
  openaiApiKey?: string;
  openaiBaseUrl?: string;
  defaultModel?: string;
  autoLoadPacks?: boolean;
  /** Optional host-provided model adapter, used by the assistant's multi-provider engine. */
  chat?: (messages: Array<{ role: "system" | "user" | "assistant"; content: string }>, options?: { model?: string; temperature?: number; maxTokens?: number; responseFormat?: "json_object" | "text" }) => Promise<string>;
}

export interface SelfBuildConfig {
  userDescription: string;
  queryCount?: number;
  maxRetries?: number;
  onProgress?: (step: string, data?: any) => void;
}
