import { fileURLToPath } from "node:url";

interface TokenStore {
  persistTokens(tokens: Record<string, string>): Promise<void>;
}

/**
 * Writes token values as new secret versions in GCP Secret Manager.
 * Used on Cloud Run so refreshed AliExpress tokens survive instance restarts.
 */
class SecretManagerStore implements TokenStore {
  private client: import("@google-cloud/secret-manager").SecretManagerServiceClient | null = null;
  private projectId: string;

  constructor(projectId: string) {
    this.projectId = projectId;
  }

  private async getClient() {
    if (!this.client) {
      const { SecretManagerServiceClient } = await import("@google-cloud/secret-manager");
      this.client = new SecretManagerServiceClient();
    }
    return this.client;
  }

  async persistTokens(tokens: Record<string, string>): Promise<void> {
    const client = await this.getClient();
    const results = await Promise.allSettled(
      Object.entries(tokens).map(async ([secretName, value]) => {
        const parent = `projects/${this.projectId}/secrets/${secretName}`;

        // Get current latest version before adding the new one
        let previousVersionName: string | null = null;
        try {
          const [version] = await client.accessSecretVersion({
            name: `${parent}/versions/latest`,
          });
          previousVersionName = version.name ?? null;
        } catch {
          // No previous version — first write for this secret
        }

        // Add new version
        await client.addSecretVersion({
          parent,
          payload: { data: Buffer.from(value, "utf8") },
        });

        // Disable the previous version to prevent unbounded accumulation
        if (previousVersionName) {
          try {
            await client.disableSecretVersion({ name: previousVersionName });
          } catch (err) {
            console.debug(`[secret-store] Failed to disable old version of ${secretName}:`, err);
          }
        }
      })
    );

    for (const [i, result] of results.entries()) {
      const secretName = Object.keys(tokens)[i];
      if (result.status === "rejected") {
        console.error(`[secret-store] Failed to update ${secretName}:`, result.reason);
      } else {
        console.log(`[secret-store] Updated ${secretName} in Secret Manager`);
      }
    }

    const failures = results.filter((r) => r.status === "rejected");
    if (failures.length > 0) {
      throw new Error(`Failed to persist ${failures.length}/${results.length} tokens to Secret Manager`);
    }
  }
}

/**
 * Falls back to writing tokens to the .env file (local development).
 */
class EnvFileStore implements TokenStore {
  private envPath: string;

  constructor(envPath: string) {
    this.envPath = envPath;
  }

  async persistTokens(tokens: Record<string, string>): Promise<void> {
    const { readFileSync, writeFileSync } = await import("node:fs");
    let content = "";
    try {
      content = readFileSync(this.envPath, "utf-8");
    } catch {
      // .env may not exist yet
    }

    for (const [key, value] of Object.entries(tokens)) {
      const regex = new RegExp(`^${key}=.*$`, "m");
      if (regex.test(content)) {
        content = content.replace(regex, `${key}=${value}`);
      } else {
        content += `\n${key}=${value}\n`;
      }
    }

    writeFileSync(this.envPath, content);
    console.log(`[secret-store] Persisted ${Object.keys(tokens).length} tokens to ${this.envPath}`);
  }
}

let _store: TokenStore | null = null;

/**
 * Returns the appropriate token store:
 * - Secret Manager when GCP_PROJECT_ID is set (production / Cloud Run)
 * - .env file fallback for local development
 */
export function getTokenStore(): TokenStore {
  if (!_store) {
    const projectId = process.env.GCP_PROJECT_ID;
    if (projectId) {
      console.log("[secret-store] Using Secret Manager for token persistence");
      _store = new SecretManagerStore(projectId);
    } else {
      const path = fileURLToPath(new URL("../../.env", import.meta.url));
      console.log("[secret-store] Using .env file for token persistence");
      _store = new EnvFileStore(path);
    }
  }
  return _store;
}
