import * as fs from "fs";
import * as path from "path";
import { Context, FileSynchronizer, GitBranchIngestor, IndexingContextMetadata } from "@zilliz/claude-context-core";
import { SnapshotManager } from "./snapshot.js";
import { ContextMcpConfig, RepositoryConfiguration } from "./config.js";

export class SyncManager {
    private context: Context;
    private snapshotManager: SnapshotManager;
    private isSyncing: boolean = false;
    private config: ContextMcpConfig;
    private branchIngestors: Map<string, GitBranchIngestor> = new Map();

    constructor(context: Context, snapshotManager: SnapshotManager, config: ContextMcpConfig) {
        this.context = context;
        this.snapshotManager = snapshotManager;
        this.config = config;
    }

    private getBranchIngestorForRepo(repo: RepositoryConfiguration): GitBranchIngestor {
        const repoPath = path.resolve(repo.path);
        if (!this.branchIngestors.has(repoPath)) {
            this.branchIngestors.set(repoPath, new GitBranchIngestor(repoPath, { baseBranch: repo.baseBranch }));
        }
        return this.branchIngestors.get(repoPath)!;
    }

    private resolveRepositoryForPath(codebasePath: string): RepositoryConfiguration | undefined {
        const absolute = path.resolve(codebasePath);
        let bestMatch: { repo: RepositoryConfiguration; length: number } | undefined;

        for (const repo of this.config.repositories) {
            const repoPath = path.resolve(repo.path);
            if (absolute === repoPath || absolute.startsWith(`${repoPath}${path.sep}`)) {
                if (!bestMatch || repoPath.length > bestMatch.length) {
                    bestMatch = { repo, length: repoPath.length };
                }
            }
        }

        if (bestMatch) {
            return bestMatch.repo;
        }

        if (this.config.defaultRepo) {
            return this.config.repositories.find(repo => repo.name === this.config.defaultRepo);
        }

        return this.config.repositories[0];
    }

    private async buildReindexMetadata(codebasePath: string): Promise<IndexingContextMetadata> {
        const absolutePath = path.resolve(codebasePath);
        const info = this.snapshotManager.getCodebaseInfo(absolutePath) as any;
        const metadata: IndexingContextMetadata = { kind: 'code' };

        let repoConfig: RepositoryConfiguration | undefined;

        if (info) {
            if (info.repo) {
                metadata.repo = info.repo;
                repoConfig = this.config.repositories.find(repo => repo.name === info.repo);
            }
            if (info.branch) {
                metadata.branch = info.branch;
            }
            if (info.baseBranch) {
                metadata.baseBranch = info.baseBranch;
            }
            if (info.path) {
                metadata.path = info.path;
            }
        }

        if (!repoConfig) {
            repoConfig = this.resolveRepositoryForPath(absolutePath);
        }

        if (repoConfig) {
            metadata.repo = metadata.repo || repoConfig.name;
            const ingest = this.getBranchIngestorForRepo(repoConfig);

            if (!metadata.branch) {
                try {
                    metadata.branch = repoConfig.currentBranch || (await ingest.getCurrentBranch()) || undefined;
                } catch (error) {
                    console.warn(`[SYNC] Failed to determine branch for ${repoConfig.name}:`, error);
                }
            }

            if (!metadata.baseBranch) {
                try {
                    metadata.baseBranch = repoConfig.baseBranch || this.config.defaultBaseBranch || (await ingest.getBaseBranch()) || metadata.branch;
                } catch (error) {
                    metadata.baseBranch = metadata.branch;
                }
            }

            if (!metadata.path) {
                try {
                    metadata.path = await ingest.getRelativePath(absolutePath);
                } catch (error) {
                    metadata.path = path.relative(path.resolve(repoConfig.path), absolutePath) || '.';
                }
            }
        }

        metadata.path = metadata.path || '.';
        return metadata;
    }

    public async handleSyncIndex(): Promise<void> {
        const syncStartTime = Date.now();
        console.log(`[SYNC-DEBUG] handleSyncIndex() called at ${new Date().toISOString()}`);

        const indexedCodebases = this.snapshotManager.getIndexedCodebases();

        if (indexedCodebases.length === 0) {
            console.log('[SYNC-DEBUG] No codebases indexed. Skipping sync.');
            return;
        }

        console.log(`[SYNC-DEBUG] Found ${indexedCodebases.length} indexed codebases:`, indexedCodebases);

        if (this.isSyncing) {
            console.log('[SYNC-DEBUG] Index sync already in progress. Skipping.');
            return;
        }

        this.isSyncing = true;
        console.log(`[SYNC-DEBUG] Starting index sync for all ${indexedCodebases.length} codebases...`);

        try {
            let totalStats = { added: 0, removed: 0, modified: 0 };

            for (let i = 0; i < indexedCodebases.length; i++) {
                const codebasePath = indexedCodebases[i];
                const codebaseStartTime = Date.now();

                console.log(`[SYNC-DEBUG] [${i + 1}/${indexedCodebases.length}] Starting sync for codebase: '${codebasePath}'`);

                // Check if codebase path still exists
                try {
                    const pathExists = fs.existsSync(codebasePath);
                    console.log(`[SYNC-DEBUG] Codebase path exists: ${pathExists}`);

                    if (!pathExists) {
                        console.warn(`[SYNC-DEBUG] Codebase path '${codebasePath}' no longer exists. Skipping sync.`);
                        continue;
                    }
                } catch (pathError: any) {
                    console.error(`[SYNC-DEBUG] Error checking codebase path '${codebasePath}':`, pathError);
                    continue;
                }

                try {
                    console.log(`[SYNC-DEBUG] Calling context.reindexByChange() for '${codebasePath}'`);
                    const metadata = await this.buildReindexMetadata(codebasePath);
                    const stats = await this.context.reindexByChange(codebasePath, undefined, metadata);
                    const codebaseElapsed = Date.now() - codebaseStartTime;

                    console.log(`[SYNC-DEBUG] Reindex stats for '${codebasePath}':`, stats);
                    console.log(`[SYNC-DEBUG] Codebase sync completed in ${codebaseElapsed}ms`);

                    // Accumulate total stats
                    totalStats.added += stats.added;
                    totalStats.removed += stats.removed;
                    totalStats.modified += stats.modified;

                    if (stats.added > 0 || stats.removed > 0 || stats.modified > 0) {
                        console.log(`[SYNC] Sync complete for '${codebasePath}'. Added: ${stats.added}, Removed: ${stats.removed}, Modified: ${stats.modified} (${codebaseElapsed}ms)`);
                    } else {
                        console.log(`[SYNC] No changes detected for '${codebasePath}' (${codebaseElapsed}ms)`);
                    }
                } catch (error: any) {
                    const codebaseElapsed = Date.now() - codebaseStartTime;
                    console.error(`[SYNC-DEBUG] Error syncing codebase '${codebasePath}' after ${codebaseElapsed}ms:`, error);
                    console.error(`[SYNC-DEBUG] Error stack:`, error.stack);

                    if (error.message.includes('Failed to query Milvus')) {
                        // Collection maybe deleted manually, delete the snapshot file
                        await FileSynchronizer.deleteSnapshot(codebasePath);
                    }

                    // Log additional error details
                    if (error.code) {
                        console.error(`[SYNC-DEBUG] Error code: ${error.code}`);
                    }
                    if (error.errno) {
                        console.error(`[SYNC-DEBUG] Error errno: ${error.errno}`);
                    }

                    // Continue with next codebase even if one fails
                }
            }

            const totalElapsed = Date.now() - syncStartTime;
            console.log(`[SYNC-DEBUG] Total sync stats across all codebases: Added: ${totalStats.added}, Removed: ${totalStats.removed}, Modified: ${totalStats.modified}`);
            console.log(`[SYNC-DEBUG] Index sync completed for all codebases in ${totalElapsed}ms`);
            console.log(`[SYNC] Index sync completed for all codebases. Total changes - Added: ${totalStats.added}, Removed: ${totalStats.removed}, Modified: ${totalStats.modified}`);
        } catch (error: any) {
            const totalElapsed = Date.now() - syncStartTime;
            console.error(`[SYNC-DEBUG] Error during index sync after ${totalElapsed}ms:`, error);
            console.error(`[SYNC-DEBUG] Error stack:`, error.stack);
        } finally {
            this.isSyncing = false;
            const totalElapsed = Date.now() - syncStartTime;
            console.log(`[SYNC-DEBUG] handleSyncIndex() finished at ${new Date().toISOString()}, total duration: ${totalElapsed}ms`);
        }
    }

    public startBackgroundSync(): void {
        console.log('[SYNC-DEBUG] startBackgroundSync() called');

        // Execute initial sync immediately after a short delay to let server initialize
        console.log('[SYNC-DEBUG] Scheduling initial sync in 5 seconds...');
        setTimeout(async () => {
            console.log('[SYNC-DEBUG] Executing initial sync after server startup');
            try {
                await this.handleSyncIndex();
            } catch (error) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                if (errorMessage.includes('Failed to query collection')) {
                    console.log('[SYNC-DEBUG] Collection not yet established, this is expected for new cluster users. Will retry on next sync cycle.');
                } else {
                    console.error('[SYNC-DEBUG] Initial sync failed with unexpected error:', error);
                    throw error;
                }
            }
        }, 5000); // Initial sync after 5 seconds

        // Periodically check for file changes and update the index
        console.log('[SYNC-DEBUG] Setting up periodic sync every 5 minutes (300000ms)');
        const syncInterval = setInterval(() => {
            console.log('[SYNC-DEBUG] Executing scheduled periodic sync');
            this.handleSyncIndex();
        }, 5 * 60 * 1000); // every 5 minutes

        console.log('[SYNC-DEBUG] Background sync setup complete. Interval ID:', syncInterval);
    }
} 