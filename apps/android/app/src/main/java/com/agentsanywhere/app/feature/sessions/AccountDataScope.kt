package com.agentsanywhere.app.feature.sessions

import com.agentsanywhere.app.api.normalizeServerOrigin
import java.security.MessageDigest

fun accountDataScope(serverUrl: String, userId: String): String {
    val origin = normalizeServerOrigin(serverUrl).orEmpty()
    return MessageDigest.getInstance("SHA-256").digest("$origin\u0000$userId".toByteArray(Charsets.UTF_8))
        .joinToString("") { "%02x".format(it.toInt() and 0xff) }
}
