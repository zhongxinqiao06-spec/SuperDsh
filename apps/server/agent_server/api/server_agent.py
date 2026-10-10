from typing import Annotated

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request, Response

from agent_server.core.models import UserView
from agent_server.core.server_agent import ServerAgentResponse
from agent_server.core.utc import utc_now
from agent_server.deps import get_rpc, get_store, require_permission
from agent_server.infra.connector_rpc import ConnectorRpcManager
from agent_server.infra.repositories.facade import Store
from agent_server.services.platform_models import ModelConfigurationError
from agent_server.services.server_agent import ServerAgentError, ServerAgents

router = APIRouter(prefix="/server-agent", tags=["server-agent"])
Reader = Annotated[UserView, Depends(require_permission("devices.read"))]
Owner = Annotated[UserView, Depends(require_permission("devices.manage"))]
Database = Annotated[Store, Depends(get_store)]
Manager = Annotated[ConnectorRpcManager, Depends(get_rpc)]


@router.get("", response_model=ServerAgentResponse)
async def get_server_agent(request: Request, user: Reader, db: Database, manager: Manager):
    return ServerAgentResponse(
        agent=await request.app.state.server_agent_login.view(user.userId),
        serverTime=utc_now(),
    )


@router.post("", response_model=ServerAgentResponse)
async def prepare_server_agent(
    request: Request, response: Response, user: Owner, db: Database, manager: Manager
):
    if not {"sessions.run", "models.use"}.issubset(user.permissions):
        raise HTTPException(403, "server Agent execution permission required")
    try:
        factory = getattr(
            request.app.state, "server_agent_http_factory", httpx.AsyncClient
        )
        agent = await ServerAgents(db, manager.is_online, factory).prepare(user.userId)
        request.app.state.server_agent_login.explicit_retry(user.userId)
    except ModelConfigurationError as exc:
        raise HTTPException(503, str(exc)) from None
    except ServerAgentError as exc:
        raise HTTPException(503, str(exc)) from None
    response.status_code = 200 if agent.status == "running" else 202
    return ServerAgentResponse(agent=agent, serverTime=utc_now())
