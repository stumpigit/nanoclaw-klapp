/**
 * Klapp Integration - Host-side IPC Handler
 *
 * Handles klapp_* IPC messages from container agents.
 * Spawns read-messages.ts as a subprocess and writes results back.
 */
/**
 * Handle klapp_* IPC messages.
 * @returns true if the message was handled, false otherwise.
 */
export declare function handleKlappIpc(data: Record<string, unknown>, sourceGroup: string, _isMain: boolean, dataDir: string): Promise<boolean>;
//# sourceMappingURL=host.d.ts.map