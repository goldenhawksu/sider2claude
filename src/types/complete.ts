/**
 * Anthropic Text Completion API Types
 *
 * Legacy API - Anthropic recommends migrating to Messages API
 *
 * Reference: https://docs.anthropic.com/en/api/complete
 */

/**
 * Text Completion Request
 */
export interface CompleteRequest {
  /** Model name (e.g., claude-2.1, claude-2.0, claude-instant-1.2) */
  model: string;

  /**
   * Prompt string in the format:
   * "\n\nHuman: {user message}\n\nAssistant:"
   */
  prompt: string;

  /** Maximum number of tokens to generate */
  max_tokens_to_sample: number;

  /** Optional: Sampling temperature (0.0 to 1.0, default 1.0) */
  temperature?: number;

  /** Optional: Nucleus sampling threshold (0.0 to 1.0, default -1 means disabled) */
  top_p?: number;

  /** Optional: Top-K sampling (default -1 means disabled) */
  top_k?: number;

  /** Optional: Stop sequences (default ["\n\nHuman:"]) */
  stop_sequences?: string[];

  /** Optional: Enable streaming (default false) */
  stream?: boolean;

  /** Optional: Metadata object */
  metadata?: {
    user_id?: string;
    [key: string]: unknown;
  };
}

/**
 * Text Completion Response
 */
export interface CompleteResponse {
  /** The completion ID */
  id: string;

  /** Response type, always "completion" */
  type: 'completion';

  /** The generated completion text */
  completion: string;

  /** The model used */
  model: string;

  /** Reason for stopping (stop_sequence, max_tokens) */
  stop_reason: 'stop_sequence' | 'max_tokens' | null;

  /** Optional: Stop sequence that was matched */
  stop?: string | null;
}

/**
 * Streaming Completion Chunk
 */
export interface CompleteStreamChunk {
  /** Chunk type */
  type: 'completion' | 'ping' | 'error';

  /** Completion text (for type: completion) */
  completion?: string;

  /** Error details (for type: error) */
  error?: {
    type: string;
    message: string;
  };

  /** Reason for stopping (only in final chunk) */
  stop_reason?: 'stop_sequence' | 'max_tokens' | null;

  /** Model name (only in final chunk) */
  model?: string;

  /** Stop sequence matched (only in final chunk) */
  stop?: string | null;
}

/**
 * Complete API Error Response
 */
export interface CompleteError {
  type: 'error';
  error: {
    type: 'invalid_request_error' | 'authentication_error' | 'permission_error' |
          'not_found_error' | 'rate_limit_error' | 'api_error' | 'overloaded_error';
    message: string;
  };
}

/**
 * Validation error details
 */
export interface CompleteValidationError {
  field: string;
  message: string;
}
