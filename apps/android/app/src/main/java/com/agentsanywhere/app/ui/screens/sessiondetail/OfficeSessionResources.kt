package com.agentsanywhere.app.ui.screens.sessiondetail

import android.content.ClipData
import android.content.Intent
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.core.content.FileProvider
import com.agentsanywhere.app.api.OfficeArtifact
import com.agentsanywhere.app.api.OfficeSessionResources
import com.agentsanywhere.app.feature.sessiondetail.DownloadedAttachment
import com.agentsanywhere.app.feature.sessiondetail.SessionDetailController
import com.agentsanywhere.app.feature.sessiondetail.cacheDownloadedAttachment
import com.agentsanywhere.app.ui.designsystem.LocalAAColors
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File

@Composable
internal fun OfficeSessionResourcesButton(sessionId: String, controller: SessionDetailController, status: String) {
    val identity = controller.officeIdentity()
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val darkMode = LocalAAColors.current.isDark
    var open by remember(sessionId, identity) { mutableStateOf(false) }
    var resources by remember(sessionId, identity) { mutableStateOf<OfficeSessionResources?>(null) }
    var error by remember(sessionId, identity) { mutableStateOf<String?>(null) }
    var busy by remember(sessionId, identity) { mutableStateOf(false) }
    var pendingSave by remember(sessionId, identity) { mutableStateOf<DownloadedAttachment?>(null) }
    var detail by remember(sessionId, identity) { mutableStateOf<String?>(null) }
    var agentChoices by remember(sessionId, identity) { mutableStateOf<Pair<List<com.agentsanywhere.app.api.BusinessAgentDefinition>, Int>?>(null) }
    val temporaryFiles = remember(sessionId, identity) { mutableSetOf<File>() }
    DisposableEffect(sessionId, identity) { onDispose { temporaryFiles.forEach { it.delete() }; temporaryFiles.clear() } }
    val saveLauncher = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("*/*")) { uri ->
        val file = pendingSave
        pendingSave = null
        if (uri != null && file != null && controller.officeIdentity() == identity) scope.launch {
            runCatching { withContext(Dispatchers.IO) { context.contentResolver.openOutputStream(uri)?.use { it.write(file.bytes) } ?: kotlin.error("无法写入所选文件") } }
                .onFailure { error = it.message }
        }
    }
    LaunchedEffect(sessionId, identity, open, status) {
        do {
            controller.officeResources(sessionId).onSuccess { if (controller.officeIdentity() == identity) { resources = it; error = null } }.onFailure { error = it.message }
            if (open) delay(3000)
        } while (open)
    }
    fun transfer(artifact: OfficeArtifact, action: String) {
        if (busy) return
        busy = true; error = null
        scope.launch {
            try {
                val preview = action == "preview" && artifact.previewFileId != null
                val fileId = if (preview) requireNotNull(artifact.previewFileId) { "预览尚未准备好，请稍后刷新或下载原文件" } else artifact.fileId
                val sha = if (preview) requireNotNull(artifact.previewSha256) else artifact.sha256
                val previewType = artifact.previewMediaType ?: if (artifact.previewName?.endsWith(".pdf", ignoreCase = true) == true) "application/pdf" else "application/octet-stream"
                val file = controller.officeDownload(sessionId, fileId, if (preview) artifact.previewName ?: "预览" else artifact.name, if (preview) previewType else artifact.mediaType, sha).getOrThrow()
                if (controller.officeIdentity() != identity) return@launch
                if (action == "save") { pendingSave = file; saveLauncher.launch(file.name) }
                else {
                    val cached = withContext(Dispatchers.IO) { cacheDownloadedAttachment(context.cacheDir, file) }
                    temporaryFiles += cached
                    val uri = FileProvider.getUriForFile(context, "${context.packageName}.attachments", cached)
                    val intent = if (action == "share") Intent(Intent.ACTION_SEND).apply { type = file.mediaType; putExtra(Intent.EXTRA_STREAM, uri); clipData = ClipData.newRawUri(file.name, uri) }
                        else Intent(Intent.ACTION_VIEW).apply { setDataAndType(uri, file.mediaType) }
                    intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                    context.startActivity(if (action == "share") Intent.createChooser(intent, "分享成果") else intent)
                }
            } catch (cancelled: kotlinx.coroutines.CancellationException) { throw cancelled }
            catch (failure: Exception) { error = failure.message ?: "文件操作失败" }
            finally { busy = false }
        }
    }
    TextButton(onClick = { open = true }) { Text("${resources?.agentName ?: "智能体"} · 方案与成果${resources?.artifacts?.size?.takeIf { it > 0 }?.let { " ($it)" } ?: ""}") }
    if (open) AlertDialog(onDismissRequest = { if (!busy) open = false }, title = { Text("方案与生成成果") }, confirmButton = { TextButton(enabled = !busy, onClick = { open = false }) { Text("关闭") } }, text = {
        LazyColumn(Modifier.fillMaxWidth().heightIn(max = 560.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
            item { OutlinedButton(enabled = !busy && status in listOf("idle", "error"), onClick = {
                busy = true
                scope.launch {
                    controller.officeAgents(sessionId).onSuccess { if (controller.officeIdentity() == identity) agentChoices = it }.onFailure { error = it.message }
                    busy = false
                }
            }) { Text("选择／切换智能体") } }
            error?.let { item { Text(it, color = MaterialTheme.colorScheme.error) } }
            if (resources == null) item { Text("正在读取会话记录…") }
            if (resources?.plans?.isEmpty() == true && resources?.artifacts?.isEmpty() == true) item { Text("在会话中提出需求。方案确认卡会在聊天中出现，完成后可在这里预览、下载和分享。") }
            resources?.plans?.forEach { plan -> item(key = plan.id) {
                Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text(plan.title + " · v" + plan.version, style = MaterialTheme.typography.titleSmall)
                    Text(officeStateLabel(plan.state, plan.stage), style = MaterialTheme.typography.bodySmall)
                    plan.error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
                    TextButton(onClick = { detail = plan.summary }) { Text("查看方案与来源") }
                    if (plan.state == "prepared") Text("请返回聊天中的确认卡确认或提出修改。", style = MaterialTheme.typography.bodySmall)
                }
            } }
            resources?.artifacts?.forEach { artifact -> item(key = artifact.fileId) {
                Column(Modifier.fillMaxWidth().padding(vertical = 6.dp), verticalArrangement = Arrangement.spacedBy(5.dp)) {
                    Text(artifact.name, style = MaterialTheme.typography.titleSmall)
                    Text("方案 v${artifact.planVersion}" + if (artifact.previousArtifactId != null) " · 修订成果，原版仍保留" else "")
                    if (artifact.draft) Text("草稿：请核对质量诊断", color = MaterialTheme.colorScheme.error)
                    artifact.diagnostics.take(3).forEach { Text(it, style = MaterialTheme.typography.bodySmall) }
                    Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        OutlinedButton(enabled = !busy && (artifact.previewFileId != null || artifact.mediaType.startsWith("image/") || artifact.mediaType.startsWith("audio/") || artifact.mediaType.startsWith("video/") || artifact.mediaType == "application/pdf"), onClick = { transfer(artifact, "preview") }) { Text("预览") }
                        Button(enabled = !busy, onClick = { transfer(artifact, "save") }) { Text("下载") }
                        OutlinedButton(enabled = !busy, onClick = { transfer(artifact, "share") }) { Text("分享") }
                    }
                }
            } }
        }
    })
    agentChoices?.let { choices -> AlertDialog(onDismissRequest = { if (!busy) agentChoices = null }, title = { Text("选择已发布智能体") }, confirmButton = { TextButton(enabled = !busy, onClick = { agentChoices = null }) { Text("返回") } }, text = {
        LazyColumn(Modifier.heightIn(max = 480.dp)) {
            item { Text("切换只影响后续任务，旧方案和成果保留原配置。") }
            choices.first.forEach { agent -> item(key = agent.id) { TextButton(enabled = !busy, onClick = {
                busy = true
                scope.launch {
                    controller.officeBindAgent(sessionId, agent.id, choices.second).onSuccess { if (controller.officeIdentity() == identity) { agentChoices = null; resources = controller.officeResources(sessionId).getOrNull() } }.onFailure { error = it.message; agentChoices = null }
                    busy = false
                }
            }) { Column { Text(agent.name + " · v" + agent.version); Text(agent.description, style = MaterialTheme.typography.bodySmall) } } } }
        }
    }) }
    detail?.let { summary -> AlertDialog(onDismissRequest = { detail = null }, title = { Text("已保存方案") }, confirmButton = { TextButton(onClick = { detail = null }) { Text("返回") } }, text = { LazyColumn(Modifier.heightIn(max = 560.dp)) { item { AgentMarkdownText(summary, darkMode) } } }) }
}

internal fun officeStateLabel(state: String, stage: String): String = when (state) {
    "prepared" -> "等待确认"
    "completed" -> "执行完成"
    "failed" -> "执行失败"
    "cancelled" -> "用户取消"
    "timed-out" -> "执行超时"
    "interrupted" -> "执行中断，未自动重放"
    "running" -> when (stage) { "rendering" -> "正在渲染最终文件"; "checking" -> "正在校验"; else -> "正在生成" }
    else -> state
}
