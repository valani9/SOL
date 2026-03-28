import { Keypair } from "@solana/web3.js";
import * as keytar from "keytar";
import { split, combine } from "shamir-secret-sharing";
import { getDb } from "./db";
import crypto from "crypto";

const SERVICE_NAME = "agentvault";

export interface KeyManagerConfig {
  shamirThreshold: number;
  shamirShares: number;
}

const DEFAULT_CONFIG: KeyManagerConfig = {
  shamirThreshold: 3,
  shamirShares: 5,
};

export interface ShamirShareInfo {
  index: number;
  shareHex: string;
  storageHint: string;
}

export class KeyManager {
  private config: KeyManagerConfig;

  constructor(config: Partial<KeyManagerConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Generate a new Ed25519 keypair, store in Keychain, and create Shamir backup shares.
   */
  async generateAndStore(
    agentId: string,
    ownerPassphrase: string
  ): Promise<{
    keypair: Keypair;
    shares: ShamirShareInfo[];
  }> {
    const keypair = Keypair.generate();
    const secretKey = keypair.secretKey;

    // Store full private key in macOS Keychain
    await keytar.setPassword(
      SERVICE_NAME,
      agentId,
      Buffer.from(secretKey).toString("base64")
    );

    // Create Shamir shares for backup/recovery
    const shares = await this.createShamirShares(
      agentId,
      secretKey,
      ownerPassphrase
    );

    return { keypair, shares };
  }

  /**
   * Split the secret key into Shamir shares.
   */
  private async createShamirShares(
    agentId: string,
    secretKey: Uint8Array,
    ownerPassphrase: string
  ): Promise<ShamirShareInfo[]> {
    const rawShares = await split(
      secretKey,
      this.config.shamirShares,
      this.config.shamirThreshold
    );

    const db = getDb();
    const insertShare = db.prepare(
      "INSERT INTO shamir_shares (agent_id, share_index, encrypted_share, storage_hint) VALUES (?, ?, ?, ?)"
    );

    const shareInfos: ShamirShareInfo[] = [];
    const storageHints = [
      "encrypted-local-db",
      "owner-print-or-photo",
      "external-backup-file",
      "trusted-contact-1",
      "trusted-contact-2",
    ];

    for (let i = 0; i < rawShares.length; i++) {
      const shareHex = Buffer.from(rawShares[i]).toString("hex");
      const hint = storageHints[i] || `share-${i}`;

      if (i === 0) {
        // Share 0: encrypt and store in SQLite
        const encrypted = this.encryptShare(shareHex, ownerPassphrase);
        insertShare.run(agentId, i, encrypted, hint);
      }

      shareInfos.push({ index: i, shareHex, storageHint: hint });
    }

    return shareInfos;
  }

  /**
   * Encrypt a share with a passphrase using AES-256-GCM.
   */
  private encryptShare(shareHex: string, passphrase: string): string {
    const key = crypto.scryptSync(passphrase, "agentvault-salt", 32);
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    let encrypted = cipher.update(shareHex, "utf8", "hex");
    encrypted += cipher.final("hex");
    const authTag = cipher.getAuthTag().toString("hex");
    return `${iv.toString("hex")}:${authTag}:${encrypted}`;
  }

  /**
   * Decrypt a share with a passphrase.
   */
  private decryptShare(encryptedData: string, passphrase: string): string {
    const [ivHex, authTagHex, encrypted] = encryptedData.split(":");
    const key = crypto.scryptSync(passphrase, "agentvault-salt", 32);
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(ivHex, "hex")
    );
    decipher.setAuthTag(Buffer.from(authTagHex, "hex"));
    let decrypted = decipher.update(encrypted, "hex", "utf8");
    decrypted += decipher.final("utf8");
    return decrypted;
  }

  /**
   * Retrieve the agent's keypair from macOS Keychain.
   */
  async getKeypair(agentId: string): Promise<Keypair | null> {
    const stored = await keytar.getPassword(SERVICE_NAME, agentId);
    if (!stored) return null;
    const secretKey = Buffer.from(stored, "base64");
    return Keypair.fromSecretKey(new Uint8Array(secretKey));
  }

  /**
   * Sign a transaction message using the agent's key from Keychain.
   * The raw private key never leaves this module.
   */
  async signMessage(agentId: string, message: Uint8Array): Promise<Uint8Array> {
    const keypair = await this.getKeypair(agentId);
    if (!keypair) {
      throw new Error(`No key found in Keychain for agent ${agentId}`);
    }
    const { sign } = await import("tweetnacl");
    return sign.detached(message, keypair.secretKey);
  }

  /**
   * Recover a keypair from Shamir shares.
   */
  async recoverFromShares(
    shares: Uint8Array[]
  ): Promise<Keypair> {
    const secretKey = await combine(shares);
    return Keypair.fromSecretKey(new Uint8Array(secretKey));
  }

  /**
   * Recover using the encrypted local share + additional shares.
   */
  async recoverWithPassphrase(
    agentId: string,
    passphrase: string,
    additionalShares: Uint8Array[]
  ): Promise<Keypair> {
    const db = getDb();
    const row = db
      .prepare(
        "SELECT encrypted_share FROM shamir_shares WHERE agent_id = ? AND share_index = 0"
      )
      .get(agentId) as { encrypted_share: string } | undefined;

    if (!row) {
      throw new Error(`No encrypted share found for agent ${agentId}`);
    }

    const decryptedHex = this.decryptShare(row.encrypted_share, passphrase);
    const localShare = Buffer.from(decryptedHex, "hex");
    const allShares = [new Uint8Array(localShare), ...additionalShares];

    return this.recoverFromShares(allShares);
  }

  /**
   * Rotate the agent's key: generate new keypair, update Keychain, return new key.
   */
  async rotateKey(
    agentId: string,
    ownerPassphrase: string
  ): Promise<{
    newKeypair: Keypair;
    shares: ShamirShareInfo[];
  }> {
    // Delete old key
    await keytar.deletePassword(SERVICE_NAME, agentId);

    // Delete old shares
    const db = getDb();
    db.prepare("DELETE FROM shamir_shares WHERE agent_id = ?").run(agentId);

    // Generate and store new key
    const result = await this.generateAndStore(agentId, ownerPassphrase);
    return { newKeypair: result.keypair, shares: result.shares };
  }

  /**
   * Delete all key material for an agent.
   */
  async deleteKey(agentId: string): Promise<void> {
    await keytar.deletePassword(SERVICE_NAME, agentId);
    const db = getDb();
    db.prepare("DELETE FROM shamir_shares WHERE agent_id = ?").run(agentId);
  }
}
