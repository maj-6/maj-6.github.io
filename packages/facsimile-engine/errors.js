export class FacsimileEngineError extends Error {
  constructor(message, code = "ENGINE_ERROR", details = undefined) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export class ProjectValidationError extends FacsimileEngineError {
  constructor(path, message) {
    super(`${path}: ${message}`, "PROJECT_VALIDATION", { path });
  }
}

export class RegistryError extends FacsimileEngineError {
  constructor(message, details) {
    super(message, "REGISTRY_ERROR", details);
  }
}

export class OperatorPollError extends FacsimileEngineError {
  constructor(operatorId, reason) {
    super(`${operatorId}: ${reason}`, "OPERATOR_POLL_FAILED", { operatorId, reason });
  }
}

export class UnsupportedExtensionError extends FacsimileEngineError {
  constructor(extensionIds) {
    const ids = [...extensionIds].sort();
    super(
      `Reader compilation requires unsupported extensions: ${ids.join(", ")}`,
      "UNSUPPORTED_REQUIRED_EXTENSION",
      { extensionIds: ids }
    );
  }
}

export class SourceReferenceError extends FacsimileEngineError {
  constructor(message, details) {
    super(message, "SOURCE_REFERENCE_IMMUTABLE", details);
  }
}

export class PublicationValidationError extends FacsimileEngineError {
  constructor(diagnostics) {
    super(
      `Publication validation failed with ${diagnostics.filter((item) => item.severity === "error").length} error(s).`,
      "PUBLICATION_VALIDATION",
      { diagnostics }
    );
  }
}
