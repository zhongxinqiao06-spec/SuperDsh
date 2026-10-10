package com.agentsanywhere.app.api

import com.agentsanywhere.app.feature.auth.SessionTokenCoordinator
import com.agentsanywhere.app.feature.auth.SessionTokens
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.net.ServerSocket
import java.net.InetAddress
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicInteger

class IdentityApiTest {
    private fun withServer(block: (TestHttpServer, String) -> Unit) {
        val server = TestHttpServer()
        try { block(server, server.origin) } finally { server.close() }
    }

    @Test fun nativeLoginUsesIdentifierAndParsesAuthorizationAndRefresh() = withServer { server, origin ->
        var request = JSONObject()
        server.route("/api/v2/auth/login") { incoming ->
            request = JSONObject(incoming.body)
            200 to """{"userId":"u","username":"alice","role":"member","roles":["member","custom"],"permissions":["devices.read"],"authzVersion":8,"resetRequired":true,"accessToken":"access","refreshToken":"refresh","expiresIn":900,"serverTime":"now"}"""
        }
        val auth = AuthApi().login(origin, " Alice ", "test-password")
        assertEquals("alice", request.getString("identifier"))
        assertEquals("native", request.getString("clientType"))
        assertFalse(request.has("email"))
        assertEquals("refresh", auth.refreshToken)
        assertEquals(listOf("member", "custom"), auth.roles)
        assertEquals(setOf("devices.read"), auth.permissions)
        assertEquals(8L, auth.authzVersion)
        assertTrue(auth.resetRequired)
    }

    @Test fun expiredBearerRetriesOnceWithRotatedTokenButForbiddenDoesNotRefresh() = withServer { server, origin ->
        val calls = AtomicInteger()
        val unauthorized = AtomicInteger()
        val coordinator = SessionTokenCoordinator(SessionTokens(origin, "old", "refresh"), {}, {
            calls.incrementAndGet()
            AuthResponse("u", "member", "new", "bearer", "now", refreshToken = "rotated")
        }, {})
        val client = ApiClient(onUnauthorized = { unauthorized.incrementAndGet() }, sessionTokens = coordinator)
        server.route("/api/v2/private") { incoming ->
            val authorized = incoming.headers["authorization"] == "Bearer new"
            (if (authorized) 200 else 401) to (if (authorized) "{\"ok\":true}" else "{\"detail\":\"expired\"}")
        }
        server.route("/api/v2/forbidden") {
            403 to "{\"detail\":\"permission denied\"}"
        }
        assertTrue(client.getJson(origin, "/private", "old").getBoolean("ok"))
        assertEquals(1, calls.get())
        try { client.getJson(origin, "/forbidden", "new"); fail("Expected forbidden") }
        catch (error: ApiException) { assertEquals(403, error.statusCode) }
        assertEquals(1, calls.get())
        assertEquals(0, unauthorized.get())
    }
}

internal data class TestRequest(val headers: Map<String, String>, val body: String, val method: String)

/** Loopback-only HTTP fixture; no Android runtime or real credentials. */
internal class TestHttpServer {
    private val socket = ServerSocket(0, 8, InetAddress.getByName("127.0.0.1"))
    private val worker = Executors.newSingleThreadExecutor()
    private val routes = ConcurrentHashMap<String, (TestRequest) -> Pair<Int, String>>()
    val origin = "http://127.0.0.1:${socket.localPort}"

    init {
        worker.execute {
            while (!socket.isClosed) runCatching {
                socket.accept().use { connection ->
                    connection.soTimeout = 3000
                    val reader = connection.getInputStream().bufferedReader(Charsets.UTF_8)
                    val requestLine = reader.readLine().split(' ')
                    val path = requestLine[1]
                    val headers = mutableMapOf<String, String>()
                    while (true) {
                        val line = reader.readLine() ?: break
                        if (line.isEmpty()) break
                        headers[line.substringBefore(':').lowercase()] = line.substringAfter(':').trim()
                    }
                    val body = CharArray(headers["content-length"]?.toIntOrNull() ?: 0)
                    var read = 0
                    while (read < body.size) {
                        val count = reader.read(body, read, body.size - read)
                        if (count < 0) break
                        read += count
                    }
                    val (status, text) = routes[path]?.invoke(TestRequest(headers, String(body), requestLine[0])) ?: (404 to "{}")
                    val bytes = text.toByteArray(Charsets.UTF_8)
                    connection.getOutputStream().apply {
                        write("HTTP/1.1 $status Test\r\nContent-Type: application/json\r\nContent-Length: ${bytes.size}\r\nConnection: close\r\n\r\n".toByteArray())
                        write(bytes)
                        flush()
                    }
                }
            }
        }
    }

    fun route(path: String, handler: (TestRequest) -> Pair<Int, String>) { routes[path] = handler }
    fun close() { socket.close(); worker.shutdownNow() }
}
