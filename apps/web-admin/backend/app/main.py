"""新管理端应用装配，唯一所有者负责数据库、资源和 DSH 生命周期。"""

import asyncio
import json
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from uuid import uuid4

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from redis.asyncio import Redis
from sqlalchemy.exc import IntegrityError
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.middleware.cors import CORSMiddleware
from starlette.responses import JSONResponse, Response

from app.api.body_limit import BodyLimitMiddleware
from app.api.compatibility import CompatibilityCatalog, CompatibilityMiddleware
from app.api.static import static_router
from app.build_metadata import read_build_info
from app.infrastructure.configuration import Settings
from app.infrastructure.crypto import CredentialCipher, PasswordSecurity
from app.infrastructure.database import Database
from app.infrastructure.errors import DomainError
from app.infrastructure.logging import configure_logging
from app.infrastructure.schema_validation import JsonSchemaValidator
from app.modules.agents.controller.agent_controller import router as agent_router
from app.modules.agents.entity.vo.agent_vo import AssetInput
from app.modules.agents.service.agent_service import AgentService
from app.modules.agents.service.package_service import ExamplePackageService
from app.modules.conversations.controller.attachment_controller import router as attachment_router
from app.modules.conversations.controller.conversation_controller import (
    router as conversation_router,
)
from app.modules.conversations.controller.stream_controller import router as stream_router
from app.modules.conversations.service.conversation_service import ConversationService
from app.modules.devices.controller.device_controller import router as device_router
from app.modules.devices.controller.operation_controller import router as device_operation_router
from app.modules.devices.controller.terminal_controller import router as terminal_router
from app.modules.devices.service.device_service import DeviceService
from app.modules.extensions.controller.extension_controller import router as extension_router
from app.modules.extensions.service.extension_service import ExtensionService
from app.modules.files.controller.file_controller import router as file_router
from app.modules.files.service.file_service import FileService
from app.modules.identity.controller.account_controller import router as account_router
from app.modules.identity.controller.oauth import router as oauth_router
from app.modules.identity.controller.routes import refresh_cookie
from app.modules.identity.controller.routes import router as identity_router
from app.modules.identity.dao.account_dao import SqlAccountRepository
from app.modules.identity.dao.oauth import SqlOAuthRepository
from app.modules.identity.dao.repository import SqlIdentityRepository
from app.modules.identity.entity.bo.models import Account
from app.modules.identity.service.account_service import AccountFlows
from app.modules.identity.service.identity import IdentityService
from app.modules.identity.service.management import AccountManagement
from app.modules.identity.service.oauth import OAuthService
from app.modules.knowledge.controller.knowledge_controller import router as knowledge_router
from app.modules.knowledge.service.knowledge_service import KnowledgeOptions, KnowledgeService
from app.modules.management.controller.system_controller import router as system_router
from app.modules.management.dao.system_dao import SqlManagementRepository
from app.modules.management.service.system_service import SystemManagement
from app.modules.models.controller.model_controller import router as model_router
from app.modules.models.controller.proxy_controller import router as proxy_router
from app.modules.models.service.configuration_service import ConfigurationService
from app.modules.models.service.model_operation_service import ModelOperationService
from app.modules.models.service.model_service import ModelService
from app.modules.models.service.proxy_service import ModelProxyService
from app.modules.models.service.startup_service import StartupModelService
from app.modules.models.service.tool_binding_service import ToolModelBindingService
from app.modules.navigation.controller.routes import router as navigation_router
from app.modules.navigation.dao.repository import SqlNavigationRepository
from app.modules.navigation.service.navigation import NavigationService
from app.modules.resources.controller.router import router as resources_router
from app.modules.resources.dao.repository import SqlResourceRepository
from app.modules.resources.service.resources import ResourceService
from app.modules.runtime.controller.router import router as runtime_router
from app.modules.runtime.service.factory import create_runtime
from app.modules.runtime.service.runtime import RuntimeService
from app.modules.skills.controller.run_controller import router as skill_run_router
from app.modules.skills.controller.skill_controller import router as skill_router
from app.modules.skills.dao.repository import SqlRunRepository
from app.modules.skills.service.agent_execution_service import AgentExecutionService
from app.modules.skills.service.evidence import EvidenceService
from app.modules.skills.service.management_service import SkillManagementService
from app.modules.skills.service.runs import SkillRunService
from app.workers.processes import ProcessWorkers
from toolkits.office.examples import prepare as prepare_examples
from toolkits.office.multimodal import MultimodalService
from toolkits.office.multimodal_tool import MultimodalTool
from toolkits.office.native_renderer import bundled_manifest
from toolkits.office.preview import PreviewService
from toolkits.office.service import OfficeService
from toolkits.office.sources import SourceResolver


@dataclass
class Services:
    """显式装配公开 service，controller 不直接读取 DAO 或 ORM。"""

    identity: IdentityService
    management: AccountManagement
    oauth: OAuthService
    navigation: NavigationService
    resources: ResourceService
    skills: SkillRunService
    evidence: EvidenceService
    accounts: AccountFlows
    system: SystemManagement
    models: ModelService
    model_configurations: ConfigurationService
    agents: AgentService
    knowledge: KnowledgeService
    files: FileService
    devices: DeviceService
    conversations: ConversationService
    extensions: ExtensionService
    skill_management: SkillManagementService
    model_proxy: ModelProxyService
    office_previews: PreviewService
    agent_execution: AgentExecutionService | None = None
    runtime: RuntimeService | None = None


def create_app(settings: Settings | None = None) -> FastAPI:
    """创建单 worker 应用；真实启动与退出由 lifespan 控制。"""
    settings = settings or Settings()
    build = read_build_info()
    logger = configure_logging()
    database = Database(settings.database_url)
    redis: Redis = Redis.from_url(settings.redis_url, socket_connect_timeout=5, socket_timeout=5)
    security = PasswordSecurity(settings.secret.get_secret_value())
    identity_repository = SqlIdentityRepository(database)
    identity = IdentityService(
        identity_repository,
        security,
        settings.setup_token.get_secret_value(),
        datetime.fromisoformat(settings.setup_token_expires_at)
        if settings.setup_token_expires_at
        else None,
    )
    resource_catalog = json.loads(
        (Path(__file__).parents[1] / "resources" / "navigation.json").read_text(encoding="utf-8")
    )
    navigation = NavigationService(
        SqlNavigationRepository(database),
        resource_catalog["modules"],
        resource_catalog["icons"],
        resource_catalog["items"],
        identity.role_choices,
    )
    validator = JsonSchemaValidator()
    cipher = CredentialCipher(settings.encryption_key.get_secret_value())
    extensions = ExtensionService(
        database,
        cipher,
        settings.data_dir / "extensions",
        Path(__file__).parents[1] / "resources/extensions/builtin-office.json",
        settings.provider_allowed_origins,
        identity.audit,
    )
    resources = ResourceService(
        SqlResourceRepository(database),
        cipher,
        validator,
        json.loads(
            (Path(__file__).parents[1] / "resources" / "default-package.json").read_text(
                encoding="utf-8"
            )
        ),
        {
            name: json.loads(
                (Path(__file__).parents[2] / "contracts" / (name + ".schema.json")).read_text(
                    encoding="utf-8"
                )
            )
            for name in ("SkillProgram", "ExtensionManifest")
        },
        extensions,
    )
    adapter = None
    if settings.use_langgraph:
        from app.workflows.references import LangGraphReferences

        adapter = LangGraphReferences()
    skills = SkillRunService(SqlRunRepository(database), resources, validator, adapter)
    system = SystemManagement(
        SqlManagementRepository(database),
        identity,
        cipher,
        settings.public_origin,
        settings.database_url,
        build,
    )
    system.allowed_origins = tuple(settings.allowed_origins)
    accounts = AccountFlows(SqlAccountRepository(database), identity, system, security)
    models = ModelService(database, cipher, settings.provider_allowed_origins, identity.audit)
    model_configurations = ConfigurationService(
        database, cipher, models.transport, identity.role_exists, identity.audit
    )
    resources.tool_binding_resolver = ToolModelBindingService(model_configurations).freeze
    files = FileService(database, settings.data_dir, cipher)
    agents = AgentService(database, resources, files, identity.audit)
    resources.asset_validator = agents.assets.validate_references
    knowledge = KnowledgeService(
        database,
        resources,
        agents,
        cipher,
        KnowledgeOptions(
            settings.data_dir / "embedding",
            settings.qdrant_url,
            settings.qdrant_api_key.get_secret_value(),
            ",".join(
                filter(None, (settings.provider_allowed_origins, settings.managed_ollama_origin))
            ),
            ",".join(
                filter(None, (settings.embedding_trusted_origins, settings.managed_ollama_origin))
            ),
        ),
        identity.audit,
        identity.get_account,
    )
    devices = DeviceService(
        database,
        lambda: services.runtime,
        settings.runtime_state_root or settings.data_dir / "runtime",
        identity,
        cipher,
        settings.secret.get_secret_value(),
    )
    conversations = ConversationService(database, devices, files)
    conversations.agent_resolver = agents.resolve_binding

    async def dashboard_facts(
        account: Account, from_date: str, to_date: str, timezone: str
    ) -> dict[str, object]:
        """总览只组合各领域公开事实，不准备DSH、不读取对话正文或设备文件。"""
        results = await asyncio.gather(
            accounts.facts(account, from_date, to_date, timezone),
            devices.facts(account, from_date, to_date, timezone),
            conversations.facts(account, from_date, to_date, timezone),
        )
        combined: dict[str, object] = {}
        for result in results:
            combined.update(result)
        return combined

    system.facts_provider = dashboard_facts
    evidence = EvidenceService(SqlRunRepository(database), skills, settings.data_dir / "objects")
    evidence.files = files
    workers = ProcessWorkers(settings.data_dir / "workers")
    example_package = json.loads(
        (Path(__file__).parents[1] / "resources/office-examples.json").read_text(encoding="utf-8")
    )

    async def example_assets() -> dict[str, AssetInput]:
        """资料生成在独立工作进程，平台只注入配置包工厂。"""
        return await prepare_examples(workers, example_package)

    agents.examples = ExamplePackageService(
        database, resources, agents.assets, example_package, example_assets
    )
    office_previews = PreviewService(
        settings.data_dir / "office/preview",
        workers,
        settings.office_executable,
        settings.office_native_manifest or bundled_manifest(settings.repository_root),
    )
    services = Services(
        identity,
        AccountManagement(identity_repository, security),
        OAuthService(SqlOAuthRepository(database), identity),
        navigation,
        resources,
        skills,
        evidence,
        accounts,
        system,
        models,
        model_configurations,
        agents,
        knowledge,
        files,
        devices,
        conversations,
        extensions,
        SkillManagementService(resources, agents.assets, extensions),
        ModelProxyService(models, identity, devices),
        office_previews,
    )

    def current_runtime() -> RuntimeService:
        """只有生命周期已取得监督器所有权后才能装配用户执行资源。"""
        if services.runtime is None:
            raise DomainError(503, "执行监督器尚未启动")
        return services.runtime

    agent_execution = AgentExecutionService(
        database,
        identity,
        resources,
        extensions,
        skills,
        evidence,
        conversations,
        current_runtime,
        settings.secret.get_secret_value(),
        knowledge=knowledge,
    )
    services.agent_execution = agent_execution
    conversations.prepare_agent = agent_execution.binding.prepare
    conversations.binding_guard = agent_execution.assert_binding_idle
    office_sources = SourceResolver(agents.assets, conversations, evidence)
    office = OfficeService(
        office_sources,
        evidence,
        knowledge,
        workers,
        office_previews,
        settings.data_dir / "office/staging",
    )
    office.multimodal = MultimodalTool(
        MultimodalService(
            model_configurations,
            ModelOperationService(database, cipher),
            identity.get_account,
            conversations.get_session,
            office.save_image,
        ),
        office_sources,
    )
    extensions.executor = office.execute
    catalog = CompatibilityCatalog(settings.compatibility_path)
    closing = False

    async def prepare_workspace(owner: str) -> None:
        """显式准备时持久化设备及唯一受管项目；只读页面不触发创建或启动。"""
        await devices.ensure_native(owner)
        await conversations.projects.ensure_native(owner)

    @asynccontextmanager
    async def lifespan(application: FastAPI) -> AsyncIterator[None]:
        nonlocal closing
        try:
            await database.ready()
            await redis.ping()
            services.runtime = await create_runtime(
                settings, database, identity, services.model_proxy, agent_execution.callback
            )
            services.runtime.on_prepare = prepare_workspace
            await identity.initialize()
            await identity.initialize_admin(
                settings.initial_admin_username,
                settings.initial_admin_password.get_secret_value(),
                settings.initial_admin_display_name,
            )
            await StartupModelService(database, cipher, identity.role_exists).initialize(
                settings.model_defaults_file
            )
            await navigation.initialize()
            await files.initialize()
            await devices.operations.initialize()
            await knowledge.initialize(settings.embedding_default)
            await skills.recover()
            yield
        finally:
            closing = True
            try:
                await devices.close()
                await devices.operations.close()
                if services.runtime is not None:
                    await services.runtime.close()
            finally:
                await workers.close()
                await redis.aclose()
                await database.close()

    app = FastAPI(title="SuperDsh Web Admin", version=str(build["version"]), lifespan=lifespan)
    instance_id = str(uuid4())
    app.state.settings, app.state.services, app.state.database, app.state.compatibility = (
        settings,
        services,
        database,
        catalog,
    )
    app.add_middleware(BodyLimitMiddleware)
    app.add_middleware(CompatibilityMiddleware, catalog=catalog)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.allowed_origins,
        allow_credentials=True,
        allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
        allow_headers=[
            "Authorization",
            "Content-Type",
            "X-Request-ID",
            "If-Match",
            "Range",
            "Idempotency-Key",
        ],
        expose_headers=[
            "X-Request-ID",
            "ETag",
            "Content-Disposition",
            "Content-Range",
            "Accept-Ranges",
        ],
    )

    @app.middleware("http")
    async def request_context(
        request: Request, call_next: Callable[[Request], Awaitable[Response]]
    ) -> Response:
        request.state.request_id = str(uuid4())
        response = await call_next(request)
        response.headers["X-Request-ID"] = request.state.request_id
        response.headers["Cache-Control"] = "no-store"
        if response.status_code in {204, 304}:
            # 无响应体状态不声明 JSON 媒体类型，保持原生客户端的空响应契约。
            for header in ("Content-Type", "Content-Length"):
                if header in response.headers:
                    del response.headers[header]
        return response

    @app.exception_handler(DomainError)
    async def domain_error(request: Request, error: DomainError) -> JSONResponse:
        response = JSONResponse(
            {"detail": error.detail, **({"code": error.code} if error.code else {})},
            status_code=error.status,
        )
        if request.scope["path"] == "/api/auth/refresh" and error.status == 401:
            refresh_cookie(request, response)
        return response

    @app.exception_handler(RequestValidationError)
    async def invalid_input(request: Request, error: RequestValidationError) -> JSONResponse:
        return JSONResponse({"detail": "invalid request parameters"}, status_code=422)

    @app.exception_handler(StarletteHTTPException)
    async def http_error(request: Request, error: StarletteHTTPException) -> JSONResponse:
        """框架未匹配入口也保持平台错误信封，不返回另一套大小写文案。"""
        detail = (
            "not found"
            if error.status_code == 404 and error.detail == "Not Found"
            else error.detail
        )
        return JSONResponse(
            {"detail": detail}, status_code=error.status_code, headers=error.headers
        )

    @app.exception_handler(IntegrityError)
    async def conflict(request: Request, error: IntegrityError) -> JSONResponse:
        return JSONResponse(
            {"detail": "record conflicts with existing data", "code": "conflict"}, status_code=409
        )

    from app.integrations.dsh.protocol import RuntimeFailure

    @app.exception_handler(RuntimeFailure)
    async def runtime_error(request: Request, error: RuntimeFailure) -> JSONResponse:
        return JSONResponse({"detail": str(error), "code": error.code}, status_code=error.status)

    @app.exception_handler(Exception)
    async def unknown_error(request: Request, error: Exception) -> JSONResponse:
        logger.error(
            "request.failed",
            extra={
                "request_id": getattr(request.state, "request_id", ""),
                "code": type(error).__name__,
            },
        )
        return JSONResponse({"detail": "internal server error"}, status_code=500)

    @app.get("/api/health/live")
    @app.get("/api/health")
    async def live() -> dict[str, object]:
        return {
            "status": "ok",
            "version": build["version"],
            "serverTime": datetime.now(UTC).isoformat(),
        }

    @app.get("/api/health/ready")
    @app.get("/health/ready", include_in_schema=False)
    async def ready() -> JSONResponse:
        database_ready = redis_ready = False
        schema_version: str | None = None
        try:
            database_ready = await database.ready()
            schema_version = await database.schema_version()
        except Exception:
            database_ready = False
        try:
            redis_ready = bool(await redis.ping())
        except Exception:
            pass
        runtime_ready = services.runtime is not None and await services.runtime.is_ready()
        healthy = database_ready and redis_ready and runtime_ready and not closing
        return JSONResponse(
            {
                "status": "ready" if healthy else "not_ready",
                "checks": {
                    "database": {
                        "status": "ok" if database_ready else "error",
                        "schemaVersion": schema_version,
                    },
                    "redis": {"status": "ok" if redis_ready else "error"},
                    "realtime": {"status": "ok" if runtime_ready and not closing else "error"},
                },
                "instanceId": instance_id,
                "serverTime": datetime.now(UTC).isoformat(),
            },
            status_code=200 if healthy else 503,
        )

    for router in (
        identity_router,
        oauth_router,
        navigation_router,
        resources_router,
        runtime_router,
        account_router,
        system_router,
        model_router,
        agent_router,
        knowledge_router,
        file_router,
        device_router,
        extension_router,
        skill_router,
        skill_run_router,
        proxy_router,
        conversation_router,
        attachment_router,
        stream_router,
        terminal_router,
        device_operation_router,
    ):
        app.include_router(router, prefix="/api")
    app.state.workers = workers
    catalog.validate_targets(app.routes)
    if settings.static_dir is not None:
        app.include_router(static_router(settings.static_dir))
    return app
