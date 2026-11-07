import { createHash } from 'node:crypto'
import type { Database } from '../infrastructure/database.ts'
import { text, utcNow } from '../http/api-router.ts'
import {
  createModelCredentialCipher,
  modelCredentialIdentity,
} from '../identity/model-credentials.ts'

/** Preserve old IDs and AAD, then re-encrypt once under the connection identity. */
export async function synchronizeLegacyConnections(
  db: Database,
  encryptionKey: string,
) {
  const cipher = createModelCredentialCipher(encryptionKey)
  await db.transaction(async (conn) => {
    await conn.query('SELECT pg_advisory_xact_lock(734521903)')
    const providers = await conn.query(
      'SELECT * FROM platform_model_providers ORDER BY id',
    )
    for (const provider of providers) {
      const connectionId = text(provider.id)
      const [old] = await conn.query(
        'SELECT * FROM model_connections WHERE id=$1',
        [connectionId],
      )
      const legacyIdentity = modelCredentialIdentity(
        connectionId,
        text(provider.owner_user_id) || undefined,
      )
      const plain = provider.key_ciphertext
        ? cipher.open(text(provider.key_ciphertext), legacyIdentity)
        : ''
      const oldPlain = old?.credential_ciphertext
        ? cipher.open(
            text(old.credential_ciphertext),
            text(old.credential_identity),
          )
        : ''
      const adapter =
        old?.adapter === 'volcengine-ark'
          ? 'volcengine-ark'
          : text(provider.protocol)
      const changed =
        !old ||
        oldPlain !== plain ||
        old.name !== provider.name ||
        old.base_url !== provider.base_url ||
        old.enabled !== provider.enabled ||
        old.adapter !== adapter
      if (changed)
        await conn.query(
          `INSERT INTO model_connections(id,owner_user_id,name,adapter,base_url,credential_ciphertext,credential_identity,legacy_provider_id,enabled,created_at,updated_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$1,$8,$9,$9) ON CONFLICT(id) DO UPDATE SET name=$3,adapter=$4,base_url=$5,credential_ciphertext=$6,credential_identity=$7,enabled=$8,revision=model_connections.revision+1,updated_at=$9`,
          [
            connectionId,
            provider.owner_user_id,
            provider.name,
            adapter,
            provider.base_url,
            plain ? cipher.seal(plain, 'connection:' + connectionId) : null,
            'connection:' + connectionId,
            provider.enabled,
            utcNow(),
          ],
        )
      const models: {
        modelId: string
        name: string
        maxTokens?: number
        contextWindow?: number
      }[] = JSON.parse(text(provider.models_json))
      for (const model of models) {
        const configurationId =
          'chat_' +
          createHash('sha256')
            .update(connectionId + '\0' + model.modelId)
            .digest('hex')
            .slice(0, 32)
        const [configuration] = await conn.query(
          "SELECT id FROM model_configurations WHERE connection_id=$1 AND model_id=$2 AND kind='chat' LIMIT 1",
          [connectionId, model.modelId],
        )
        if (!configuration) {
          const now = utcNow()
          const parameters = {
            maxTokens: model.maxTokens || 4096,
            ...(model.contextWindow
              ? { contextWindow: model.contextWindow }
              : {}),
          }
          await conn.query(
            `INSERT INTO model_configurations(id,connection_id,name,kind,capability,model_id,parameters_json,created_at,updated_at) VALUES($1,$2,$3,'chat','chat',$4,$5,$6,$6)`,
            [
              configurationId,
              connectionId,
              model.name,
              model.modelId,
              JSON.stringify(parameters),
              now,
            ],
          )
          const definition = {
            id: configurationId,
            name: model.name,
            kind: 'chat',
            capability: 'chat',
            connectionId,
            modelId: model.modelId,
            revision: 1,
            enabled: true,
            parameters,
            roleIds: [],
          }
          await conn.query(
            'INSERT INTO model_configuration_versions(configuration_id,revision,definition_json,created_at) VALUES($1,1,$2,$3)',
            [configurationId, JSON.stringify(definition), now],
          )
        }
      }
    }
    await conn.query(
      `UPDATE model_configurations m SET enabled=0 FROM model_connections c,platform_model_providers p WHERE m.connection_id=c.id AND c.legacy_provider_id=p.id AND m.kind='chat' AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p.models_json::jsonb) entry WHERE entry->>'modelId'=m.model_id)`,
    )
    await conn.query(
      `INSERT INTO model_capability_defaults(capability,configuration_id,updated_at)
      SELECT 'chat',m.id,$1 FROM platform_model_defaults d JOIN model_configurations m ON m.connection_id=d.provider_id AND m.model_id=d.model_id AND m.kind='chat'
      WHERE d.id='global' ORDER BY m.id LIMIT 1 ON CONFLICT(capability) DO UPDATE SET configuration_id=EXCLUDED.configuration_id,revision=model_capability_defaults.revision+1,updated_at=EXCLUDED.updated_at WHERE model_capability_defaults.configuration_id IS DISTINCT FROM EXCLUDED.configuration_id`,
      [utcNow()],
    )
    await conn.query(
      "UPDATE model_capability_defaults SET configuration_id=NULL,revision=revision+1 WHERE capability='chat' AND configuration_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM platform_model_defaults WHERE id='global')",
    )
    await conn.query(
      'UPDATE model_connections SET enabled=0 WHERE legacy_provider_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM platform_model_providers p WHERE p.id=model_connections.legacy_provider_id)',
    )
  })
}
