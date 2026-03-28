import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
  SystemProgram,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  Actions,
  createEd25519AuthorityInfo,
  findSwigPda,
  getCreateSwigInstruction,
  getAddAuthorityInstructions,
  getSignInstructions,
  getRemoveAuthorityInstructions,
  getUpdateAuthorityInstructions,
  updateAuthorityReplaceAllActions,
  fetchSwig,
  type Swig,
  type CreateAuthorityInfo,
} from "@swig-wallet/classic";
import crypto from "crypto";

export interface SwigWalletInfo {
  swigAddress: PublicKey;
  swigId: Uint8Array;
  ownerRoleId: number;
  agentRoleId: number;
}

export interface AgentLimits {
  solPerTxLamports: bigint;
  dailySolLamports: bigint;
  windowSlots: bigint;
  allowedPrograms: PublicKey[];
}

const DEFAULT_WINDOW_SLOTS = 216_000n; // ~1 day at 400ms/slot

export class SwigManager {
  private connection: Connection;

  constructor(connection: Connection) {
    this.connection = connection;
  }

  /**
   * Create a new Swig wallet with an owner authority (full control)
   * and an agent authority (restricted permissions).
   */
  async createWallet(
    payer: Keypair,
    ownerPubkey: PublicKey,
    agentPubkey: PublicKey,
    limits: AgentLimits
  ): Promise<SwigWalletInfo> {
    const swigId = crypto.randomBytes(32);
    const swigAddress = findSwigPda(swigId);

    // Owner gets full control
    const ownerAuthorityInfo = createEd25519AuthorityInfo(ownerPubkey);
    const ownerActions = Actions.set().all().get();

    // Create the Swig wallet with owner as the initial authority
    const createIx = await getCreateSwigInstruction({
      payer: payer.publicKey,
      id: swigId,
      actions: ownerActions,
      authorityInfo: ownerAuthorityInfo,
    });

    const createTx = new Transaction().add(createIx);
    await sendAndConfirmTransaction(this.connection, createTx, [payer]);

    // Fetch the created Swig to get the role structure
    const swig = await fetchSwig(this.connection, swigAddress);
    const ownerRoleId = swig.roles[0].id;

    // Add the agent authority with restricted permissions
    const agentAuthorityInfo = createEd25519AuthorityInfo(agentPubkey);
    const agentActions = this.buildAgentActions(limits);

    const addAuthorityIxs = await getAddAuthorityInstructions(
      swig,
      ownerRoleId,
      agentAuthorityInfo,
      agentActions
    );

    const addTx = new Transaction().add(...addAuthorityIxs);
    await sendAndConfirmTransaction(this.connection, addTx, [payer]);

    // Re-fetch to get agent's role ID
    const updatedSwig = await fetchSwig(this.connection, swigAddress);
    const agentRoleId = updatedSwig.roles[updatedSwig.roles.length - 1].id;

    return {
      swigAddress,
      swigId,
      ownerRoleId,
      agentRoleId,
    };
  }

  /**
   * Build the agent's Actions based on limits.
   */
  buildAgentActions(limits: AgentLimits): Actions {
    let builder = Actions.set().solRecurringLimit({
      recurringAmount: limits.dailySolLamports,
      window: limits.windowSlots || DEFAULT_WINDOW_SLOTS,
    });

    // Add allowed programs
    for (const programId of limits.allowedPrograms) {
      builder = builder.programLimit({ programId });
    }

    return builder.get();
  }

  /**
   * Update the agent's permissions on-chain.
   */
  async updateAgentPermissions(
    payer: Keypair,
    swigAddress: PublicKey,
    ownerRoleId: number,
    agentRoleId: number,
    newLimits: AgentLimits
  ): Promise<void> {
    const swig = await fetchSwig(this.connection, swigAddress);
    const newActions = this.buildAgentActions(newLimits);

    const updateIxs = await getUpdateAuthorityInstructions(
      swig,
      ownerRoleId,
      agentRoleId,
      updateAuthorityReplaceAllActions(newActions)
    );

    const tx = new Transaction().add(...updateIxs);
    await sendAndConfirmTransaction(this.connection, tx, [payer]);
  }

  /**
   * Sign instructions through the Swig wallet using the agent's role.
   */
  async signThroughSwig(
    swigAddress: PublicKey,
    agentRoleId: number,
    innerInstructions: TransactionInstruction[]
  ): Promise<TransactionInstruction[]> {
    const swig = await fetchSwig(this.connection, swigAddress);
    return getSignInstructions(swig, agentRoleId, innerInstructions);
  }

  /**
   * Execute a transaction through Swig - wraps inner instructions with Swig signing.
   */
  async executeThrough(
    payer: Keypair,
    agentKeypair: Keypair,
    swigAddress: PublicKey,
    agentRoleId: number,
    innerInstructions: TransactionInstruction[]
  ): Promise<string> {
    const signedIxs = await this.signThroughSwig(
      swigAddress,
      agentRoleId,
      innerInstructions
    );

    const tx = new Transaction().add(...signedIxs);
    return sendAndConfirmTransaction(this.connection, tx, [
      payer,
      agentKeypair,
    ]);
  }

  /**
   * Remove the agent's authority (freeze).
   */
  async freezeAgent(
    payer: Keypair,
    swigAddress: PublicKey,
    ownerRoleId: number,
    agentRoleId: number
  ): Promise<void> {
    const swig = await fetchSwig(this.connection, swigAddress);
    const removeIxs = await getRemoveAuthorityInstructions(
      swig,
      ownerRoleId,
      agentRoleId
    );

    const tx = new Transaction().add(...removeIxs);
    await sendAndConfirmTransaction(this.connection, tx, [payer]);
  }

  /**
   * Fetch the current Swig account state.
   */
  async fetchSwig(swigAddress: PublicKey): Promise<Swig> {
    return fetchSwig(this.connection, swigAddress);
  }

  /**
   * Get the Swig wallet's SOL balance.
   */
  async getBalance(swigAddress: PublicKey): Promise<number> {
    const lamports = await this.connection.getBalance(swigAddress);
    return lamports / LAMPORTS_PER_SOL;
  }

  /**
   * Build a SOL transfer instruction from the Swig wallet.
   */
  buildSolTransferIx(
    swigAddress: PublicKey,
    destination: PublicKey,
    lamports: bigint
  ): TransactionInstruction {
    return SystemProgram.transfer({
      fromPubkey: swigAddress,
      toPubkey: destination,
      lamports: Number(lamports),
    });
  }
}
