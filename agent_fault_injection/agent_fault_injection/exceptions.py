"""Domain-specific exceptions."""


class AgentRasEvalError(Exception):
    """Base exception for expected user-facing failures."""


class ConfigurationError(AgentRasEvalError):
    """The experiment request or configuration is invalid."""


class PlatformNotFoundError(AgentRasEvalError):
    """The requested platform adapter is not registered."""


class PlatformExecutableNotFoundError(AgentRasEvalError):
    """The selected platform executable cannot be found."""


class FaultNotFoundError(AgentRasEvalError):
    """The requested fault is not registered."""


class InstallationConflictError(AgentRasEvalError):
    """A managed file would overwrite a user-owned file."""


class ToolInstallationError(AgentRasEvalError):
    """Expected agent tools were missing after install into the workspace."""


class PluginStartupError(AgentRasEvalError):
    """The platform plugin did not become ready."""


class PlatformConnectionError(AgentRasEvalError):
    """The platform model provider remained unavailable."""


class ExperimentTimeoutError(AgentRasEvalError):
    """The platform did not finish within the configured timeout."""


class MappingError(AgentRasEvalError):
    """Raw platform events could not be mapped."""


class EvaluationError(AgentRasEvalError):
    """The isolated judge could not produce a valid fault decision."""
