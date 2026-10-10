from typing import Literal

from pydantic import BaseModel


class ServerAgentView(BaseModel):
    status: Literal["stopped", "starting", "running", "error"] = "stopped"
    connectorId: str | None = None
    runtimeId: str | None = None
    projectId: str | None = None
    error: str | None = None


class ServerAgentResponse(BaseModel):
    agent: ServerAgentView
    serverTime: str
