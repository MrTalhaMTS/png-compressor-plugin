// Errors that are safe to show to the user. Anything else is reported as an internal error.
export class ToolError extends Error {
  constructor(message) {
    super(message);
    this.name = "ToolError";
  }
}

export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}
