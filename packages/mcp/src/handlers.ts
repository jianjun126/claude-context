import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { Context, COLLECTION_LIMIT_MESSAGE, GitBranchIngestor, IndexingContextMetadata, SemanticSearchResult } from "@zilliz/claude-context-core";
import { SnapshotManager } from "./snapshot.js";
import { ensureAbsolutePath, truncateContent, trackCodebasePath } from "./utils.js";
import { ContextMcpConfig, RepositoryConfiguration, CodebaseMetadataFields } from "./config.js";

export class ToolHandlers {
    private context: Context;
    private snapshotManager: SnapshotManager;
    private indexingStats: { indexedFiles: number; totalChunks: number } | null = null;
    private currentWorkspace: string;
    private config: ContextMcpConfig;
    private branchIngestors: Map<string, GitBranchIngestor> = new Map();
    private indexingMetadataCache: Map<string, CodebaseMetadataFields> = new Map();

    constructor(context: Context, snapshotManager: SnapshotManager, config: ContextMcpConfig) {
        this.context = context;
        this.snapshotManager = snapshotManager;
        this.config = config;
        this.currentWorkspace = process.cwd();
        console.log(`[WORKSPACE] Current workspace: ${this.currentWorkspace}`);
    }

    private getRepositoryConfigByName(name: string | undefined): RepositoryConfiguration | undefined {
        if (!name) {
            return undefined;
        }
        return this.config.repositories.find(repo => repo.name === name);
    }

    private resolveRepositoryForPath(codebasePath: string): RepositoryConfiguration | undefined {
        const absolute = ensureAbsolutePath(codebasePath);
        let bestMatch: { repo: RepositoryConfiguration; length: number } | undefined;

        for (const repo of this.config.repositories) {
            const repoPath = ensureAbsolutePath(repo.path);
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
            return this.getRepositoryConfigByName(this.config.defaultRepo);
        }

        return this.config.repositories[0];
    }

    private getBranchIngestorForRepo(repo: RepositoryConfiguration): GitBranchIngestor {
        const repoPath = ensureAbsolutePath(repo.path);
        if (!this.branchIngestors.has(repoPath)) {
            this.branchIngestors.set(repoPath, new GitBranchIngestor(repoPath, { baseBranch: repo.baseBranch }));
        }
        return this.branchIngestors.get(repoPath)!;
    }

    private async buildIndexMetadata(codebasePath: string, repoConfig?: RepositoryConfiguration): Promise<CodebaseMetadataFields> {
        const absolutePath = ensureAbsolutePath(codebasePath);
        const repo = repoConfig ?? this.resolveRepositoryForPath(absolutePath);
        const metadata: CodebaseMetadataFields = { kind: 'code' };

        if (!repo) {
            metadata.path = path.basename(absolutePath);
            return metadata;
        }

        metadata.repo = repo.name;
        const ingest = this.getBranchIngestorForRepo(repo);

        let branch = repo.currentBranch || this.config.defaultBranch;
        try {
            branch = branch || (await ingest.getCurrentBranch()) || undefined;
        } catch (error) {
            console.warn(`[REPO] Failed to determine current branch for ${repo.name}:`, error);
        }

        let baseBranch = repo.baseBranch || this.config.defaultBaseBranch;
        try {
            baseBranch = baseBranch || (await ingest.getBaseBranch()) || undefined;
        } catch (error) {
            console.warn(`[REPO] Failed to determine base branch for ${repo.name}:`, error);
        }

        let relativePath = '.';
        try {
            relativePath = await ingest.getRelativePath(absolutePath);
        } catch (error) {
            relativePath = path.relative(ensureAbsolutePath(repo.path), absolutePath) || '.';
        }

        metadata.branch = branch || undefined;
        metadata.baseBranch = baseBranch || metadata.branch;
        metadata.path = relativePath || '.';

        return metadata;
    }

    private buildSnapshotMetadata(metadata: CodebaseMetadataFields): CodebaseMetadataFields {
        const repoName = metadata.repo || 'codebase';
        const branch = metadata.branch || 'HEAD';
        const location = metadata.path && metadata.path !== '.' ? `:${metadata.path}` : '';
        return {
            ...metadata,
            summary: `${repoName}${location}@${branch}`
        };
    }

    private cacheIndexingMetadata(codebasePath: string, metadata: CodebaseMetadataFields): void {
        this.indexingMetadataCache.set(ensureAbsolutePath(codebasePath), metadata);
    }

    private shouldScanBranches(repoConfig?: RepositoryConfiguration): boolean {
        if (!repoConfig) {
            return false;
        }

        if (typeof repoConfig.scanBranches === 'boolean') {
            return repoConfig.scanBranches;
        }

        if (typeof this.config.enableBranchScan === 'boolean') {
            return this.config.enableBranchScan;
        }

        return false;
    }

    private getBranchScanLimit(): number | undefined {
        const limit = this.config.maxBranchScan;
        if (typeof limit === 'number' && limit > 0) {
            return limit;
        }
        return undefined;
    }

    private async indexAdditionalBranches(
        repoConfig: RepositoryConfiguration,
        absolutePath: string,
        baseMetadata: CodebaseMetadataFields,
        snapshotMetadata: CodebaseMetadataFields
    ): Promise<Array<{ branch: string; stats: { indexedFiles: number; totalChunks: number; status: 'completed' | 'limit_reached' } }>> {
        if (!this.shouldScanBranches(repoConfig)) {
            return [];
        }

        const repoName = baseMetadata.repo || repoConfig.name;
        const ingestor = this.getBranchIngestorForRepo(repoConfig);

        let branches: string[] = [];
        try {
            branches = await ingestor.listBranches(false);
        } catch (error) {
            console.warn(`[BACKGROUND-INDEX] Failed to list branches for '${repoConfig.name}':`, error);
            return [];
        }

        const currentBranch = baseMetadata.branch || repoConfig.currentBranch || this.config.defaultBranch;
        const baseBranch = baseMetadata.baseBranch || repoConfig.baseBranch || this.config.defaultBaseBranch;

        const seen = new Set<string>();
        const orderedBranches: string[] = [];
        const pushBranch = (name?: string | null) => {
            if (!name) {
                return;
            }
            if (seen.has(name)) {
                return;
            }
            seen.add(name);
            orderedBranches.push(name);
        };

        if (baseBranch && baseBranch !== currentBranch) {
            pushBranch(baseBranch);
        }

        for (const branch of branches) {
            if (branch === currentBranch) {
                continue;
            }
            pushBranch(branch);
        }

        if (orderedBranches.length === 0) {
            console.log(`[BACKGROUND-INDEX] Branch scan enabled for '${repoConfig.name}', but no eligible branches were found.`);
            return [];
        }

        const limit = this.getBranchScanLimit();
        const targetBranches = typeof limit === 'number'
            ? orderedBranches.slice(0, limit)
            : orderedBranches;

        const processedBranches: Array<{ branch: string; stats: { indexedFiles: number; totalChunks: number; status: 'completed' | 'limit_reached' } }> = [];
        const locationSuffix = snapshotMetadata.path && snapshotMetadata.path !== '.'
            ? `:${snapshotMetadata.path}`
            : '';

        console.log(`[BACKGROUND-INDEX] Branch scan enabled for '${repoConfig.name}'. Target branches: ${targetBranches.join(', ')}`);

        for (const branchName of targetBranches) {
            console.log(`[BACKGROUND-INDEX] ▶️  Indexing branch '${branchName}' for repository '${repoConfig.name}'`);
            try {
                await ingestor.withBranchWorktree(branchName, async (worktreePath) => {
                    const branchMetadata: IndexingContextMetadata = {
                        repo: repoName,
                        branch: branchName,
                        baseBranch: baseBranch || branchName,
                        path: baseMetadata.path || '.',
                        kind: baseMetadata.kind || 'code',
                    };

                    const branchSnapshot: CodebaseMetadataFields = {
                        ...snapshotMetadata,
                        repo: repoName,
                        branch: branchName,
                        baseBranch: branchMetadata.baseBranch,
                        summary: `${repoName}${locationSuffix}@${branchName}`
                    };

                    this.snapshotManager.setCodebaseIndexing(absolutePath, 0, branchSnapshot);
                    this.snapshotManager.saveCodebaseSnapshot();

                    const removed = await this.context.clearBranchDocuments(absolutePath, branchName, repoName);
                    if (removed > 0) {
                        console.log(`[BACKGROUND-INDEX] 🧹 Cleared ${removed} stale chunks for branch '${branchName}'.`);
                    }

                    const stats = await this.context.indexCodebase(
                        absolutePath,
                        undefined,
                        false,
                        branchMetadata,
                        { sourceRoot: worktreePath }
                    );

                    console.log(`[BACKGROUND-INDEX] ✅ Indexed branch '${branchName}' (${stats.indexedFiles} files, ${stats.totalChunks} chunks).`);

                    this.snapshotManager.setCodebaseIndexed(absolutePath, stats, branchSnapshot);
                    this.snapshotManager.saveCodebaseSnapshot();
                    processedBranches.push({ branch: branchName, stats });
                });
            } catch (error: any) {
                console.error(`[BACKGROUND-INDEX] ❌ Error indexing branch '${branchName}' for repository '${repoConfig.name}':`, error?.message || error);
            }
        }

        return processedBranches;
    }

    private escapeFilterValue(value: string): string {
        return value.replace(/"/g, '\\"');
    }

    private buildFilterExpression(repo?: string, branch?: string, excludeBranches: string[] = []): string {
        const clauses: string[] = [];
        if (repo) {
            clauses.push(`repo == "${this.escapeFilterValue(repo)}"`);
        }
        if (branch) {
            clauses.push(`branch == "${this.escapeFilterValue(branch)}"`);
        }
        for (const exclude of excludeBranches) {
            clauses.push(`branch != "${this.escapeFilterValue(exclude)}"`);
        }
        return clauses.join(' && ');
    }

    private formatSemanticResults(results: SemanticSearchResult[]): string {
        if (results.length === 0) {
            return '  (no matches)';
        }

        return results
            .map(result => {
                const location = `${result.relativePath}:${result.startLine}-${result.endLine}`;
                const score = result.score !== undefined ? `score=${result.score.toFixed(3)}` : '';
                return `  - ${location} ${score}`.trim();
            })
            .join('\n');
    }

    private sanitizeLimit(limit: any, defaultValue: number = 10): number {
        if (typeof limit === 'number' && Number.isFinite(limit)) {
            return Math.min(Math.max(Math.floor(limit), 1), 50);
        }
        if (typeof limit === 'string' && limit.trim().length > 0) {
            const parsed = Number(limit);
            if (Number.isFinite(parsed)) {
                return Math.min(Math.max(Math.floor(parsed), 1), 50);
            }
        }
        return defaultValue;
    }

    private normalizePathForComparison(value: string): string {
        return value.replace(/\\/g, '/').replace(/\/+$/, '');
    }

    private applyPathScope(results: SemanticSearchResult[], scope?: string): SemanticSearchResult[] {
        if (!scope || scope === '.' || scope.trim().length === 0) {
            return results;
        }

        const normalizedScope = this.normalizePathForComparison(scope);
        const scopePrefix = normalizedScope.length > 0 ? `${normalizedScope}/` : '';

        return results.filter(result => {
            const relative = this.normalizePathForComparison(result.relativePath || result.path || '');
            return relative === normalizedScope || relative.startsWith(scopePrefix);
        });
    }

    private dedupeResults(results: SemanticSearchResult[], seen: Set<string>): SemanticSearchResult[] {
        const deduped: SemanticSearchResult[] = [];
        for (const result of results) {
            const key = `${result.branch || 'HEAD'}|${result.relativePath}|${result.startLine}|${result.endLine}`;
            if (seen.has(key)) {
                continue;
            }
            seen.add(key);
            deduped.push(result);
        }
        return deduped;
    }

    private formatDetailedResults(results: SemanticSearchResult[], includeBranchInfo: boolean = false): string {
        if (results.length === 0) {
            return '  (no matches)';
        }

        return results
            .map((result, index) => {
                const branchLabel = includeBranchInfo ? ` [${result.branch || 'unknown'}]` : '';
                const location = `${index + 1}. ${result.relativePath}:${result.startLine}-${result.endLine}${branchLabel}`;
                const scoreText = result.score !== undefined ? ` (score=${result.score.toFixed(3)})` : '';
                const summaryText = result.summary ? `\n   Summary: ${result.summary}` : '';
                const snippet = truncateContent(result.content, 800);
                const language = result.language || 'text';
                const snippetBlock = `\n\`\`\`${language}\n${snippet}\n\`\`\``;
                return `${location}${scoreText}${summaryText}${snippetBlock}`;
            })
            .join('\n\n');
    }

    /**
     * Sync indexed codebases from Zilliz Cloud collections
     * This method fetches all collections from the vector database,
     * gets the first document from each collection to extract codebasePath from metadata,
     * and updates the snapshot with discovered codebases.
     * 
     * Logic: Compare mcp-codebase-snapshot.json with zilliz cloud collections
     * - If local snapshot has extra directories (not in cloud), remove them
     * - If local snapshot is missing directories (exist in cloud), ignore them
     */
    private async syncIndexedCodebasesFromCloud(): Promise<void> {
        try {
            console.log(`[SYNC-CLOUD] 🔄 Syncing indexed codebases from Zilliz Cloud...`);

            // Get all collections using the interface method
            const vectorDb = this.context.getVectorDatabase();

            // Use the new listCollections method from the interface
            const collections = await vectorDb.listCollections();

            console.log(`[SYNC-CLOUD] 📋 Found ${collections.length} collections in Zilliz Cloud`);

            if (collections.length === 0) {
                console.log(`[SYNC-CLOUD] ✅ No collections found in cloud`);
                // If no collections in cloud, remove all local codebases
                const localCodebases = this.snapshotManager.getIndexedCodebases();
                if (localCodebases.length > 0) {
                    console.log(`[SYNC-CLOUD] 🧹 Removing ${localCodebases.length} local codebases as cloud has no collections`);
                    for (const codebasePath of localCodebases) {
                        this.snapshotManager.removeIndexedCodebase(codebasePath);
                        console.log(`[SYNC-CLOUD] ➖ Removed local codebase: ${codebasePath}`);
                    }
                    this.snapshotManager.saveCodebaseSnapshot();
                    console.log(`[SYNC-CLOUD] 💾 Updated snapshot to match empty cloud state`);
                }
                return;
            }

            const cloudCodebases = new Set<string>();

            // Check each collection for codebase path
            for (const collectionName of collections) {
                try {
                    // Skip collections that don't match the code_chunks pattern (support both legacy and new collections)
                    if (!collectionName.startsWith('code_chunks_') && !collectionName.startsWith('hybrid_code_chunks_')) {
                        console.log(`[SYNC-CLOUD] ⏭️  Skipping non-code collection: ${collectionName}`);
                        continue;
                    }

                    console.log(`[SYNC-CLOUD] 🔍 Checking collection: ${collectionName}`);

                    // Query the first document to get metadata
                    const results = await vectorDb.query(
                        collectionName,
                        '', // Empty filter to get all results
                        ['metadata'], // Only fetch metadata field
                        1 // Only need one result to extract codebasePath
                    );

                    if (results && results.length > 0) {
                        const firstResult = results[0];
                        const metadataStr = firstResult.metadata;

                        if (metadataStr) {
                            try {
                                const metadata = JSON.parse(metadataStr);
                                const codebasePath = metadata.codebasePath;

                                if (codebasePath && typeof codebasePath === 'string') {
                                    console.log(`[SYNC-CLOUD] 📍 Found codebase path: ${codebasePath} in collection: ${collectionName}`);
                                    cloudCodebases.add(codebasePath);
                                } else {
                                    console.warn(`[SYNC-CLOUD] ⚠️  No codebasePath found in metadata for collection: ${collectionName}`);
                                }
                            } catch (parseError) {
                                console.warn(`[SYNC-CLOUD] ⚠️  Failed to parse metadata JSON for collection ${collectionName}:`, parseError);
                            }
                        } else {
                            console.warn(`[SYNC-CLOUD] ⚠️  No metadata found in collection: ${collectionName}`);
                        }
                    } else {
                        console.log(`[SYNC-CLOUD] ℹ️  Collection ${collectionName} is empty`);
                    }
                } catch (collectionError: any) {
                    console.warn(`[SYNC-CLOUD] ⚠️  Error checking collection ${collectionName}:`, collectionError.message || collectionError);
                    // Continue with next collection
                }
            }

            console.log(`[SYNC-CLOUD] 📊 Found ${cloudCodebases.size} valid codebases in cloud`);

            // Get current local codebases
            const localCodebases = new Set(this.snapshotManager.getIndexedCodebases());
            console.log(`[SYNC-CLOUD] 📊 Found ${localCodebases.size} local codebases in snapshot`);

            let hasChanges = false;

            // Remove local codebases that don't exist in cloud
            for (const localCodebase of localCodebases) {
                if (!cloudCodebases.has(localCodebase)) {
                    this.snapshotManager.removeIndexedCodebase(localCodebase);
                    hasChanges = true;
                    console.log(`[SYNC-CLOUD] ➖ Removed local codebase (not in cloud): ${localCodebase}`);
                }
            }

            // Note: We don't add cloud codebases that are missing locally (as per user requirement)
            console.log(`[SYNC-CLOUD] ℹ️  Skipping addition of cloud codebases not present locally (per sync policy)`);

            if (hasChanges) {
                this.snapshotManager.saveCodebaseSnapshot();
                console.log(`[SYNC-CLOUD] 💾 Updated snapshot to match cloud state`);
            } else {
                console.log(`[SYNC-CLOUD] ✅ Local snapshot already matches cloud state`);
            }

            console.log(`[SYNC-CLOUD] ✅ Cloud sync completed successfully`);
        } catch (error: any) {
            console.error(`[SYNC-CLOUD] ❌ Error syncing codebases from cloud:`, error.message || error);
            // Don't throw - this is not critical for the main functionality
        }
    }

    public async handleIndexCodebase(args: any) {
        const { path: codebasePath, force, splitter, customExtensions, ignorePatterns } = args;
        const forceReindex = force || false;
        const splitterType = splitter || 'ast'; // Default to AST
        const customFileExtensions = customExtensions || [];
        const customIgnorePatterns = ignorePatterns || [];

        try {
            // Sync indexed codebases from cloud first
            await this.syncIndexedCodebasesFromCloud();

            // Validate splitter parameter
            if (splitterType !== 'ast' && splitterType !== 'langchain') {
                return {
                    content: [{
                        type: "text",
                        text: `Error: Invalid splitter type '${splitterType}'. Must be 'ast' or 'langchain'.`
                    }],
                    isError: true
                };
            }
            // Force absolute path resolution - warn if relative path provided
            const absolutePath = ensureAbsolutePath(codebasePath);

            // Validate path exists
            if (!fs.existsSync(absolutePath)) {
                return {
                    content: [{
                        type: "text",
                        text: `Error: Path '${absolutePath}' does not exist. Original input: '${codebasePath}'`
                    }],
                    isError: true
                };
            }

            const repoConfig = this.resolveRepositoryForPath(absolutePath);
            const indexMetadata = await this.buildIndexMetadata(absolutePath, repoConfig);
            const snapshotMetadata = this.buildSnapshotMetadata(indexMetadata);
            this.cacheIndexingMetadata(absolutePath, indexMetadata);

            // Check if it's a directory
            const stat = fs.statSync(absolutePath);
            if (!stat.isDirectory()) {
                return {
                    content: [{
                        type: "text",
                        text: `Error: Path '${absolutePath}' is not a directory`
                    }],
                    isError: true
                };
            }

            // Check if already indexing
            if (this.snapshotManager.getIndexingCodebases().includes(absolutePath)) {
                return {
                    content: [{
                        type: "text",
                        text: `Codebase '${absolutePath}' is already being indexed in the background. Please wait for completion.`
                    }],
                    isError: true
                };
            }

            //Check if the snapshot and cloud index are in sync
            if (this.snapshotManager.getIndexedCodebases().includes(absolutePath) !== await this.context.hasIndex(absolutePath)) {
                console.warn(`[INDEX-VALIDATION] ❌ Snapshot and cloud index mismatch: ${absolutePath}`);
            }

            // Check if already indexed (unless force is true)
            if (!forceReindex && this.snapshotManager.getIndexedCodebases().includes(absolutePath)) {
                return {
                    content: [{
                        type: "text",
                        text: `Codebase '${absolutePath}' is already indexed. Use force=true to re-index.`
                    }],
                    isError: true
                };
            }

            // If force reindex and codebase is already indexed, remove it
            if (forceReindex) {
                if (this.snapshotManager.getIndexedCodebases().includes(absolutePath)) {
                    console.log(`[FORCE-REINDEX] 🔄 Removing '${absolutePath}' from indexed list for re-indexing`);
                    this.snapshotManager.removeIndexedCodebase(absolutePath);
                }
                if (await this.context.hasIndex(absolutePath)) {
                    console.log(`[FORCE-REINDEX] 🔄 Clearing index for '${absolutePath}'`);
                    await this.context.clearIndex(absolutePath);
                }
            }

            // CRITICAL: Pre-index collection creation validation
            try {
                console.log(`[INDEX-VALIDATION] 🔍 Validating collection creation capability`);
                const canCreateCollection = await this.context.getVectorDatabase().checkCollectionLimit();

                if (!canCreateCollection) {
                    console.error(`[INDEX-VALIDATION] ❌ Collection limit validation failed: ${absolutePath}`);

                    // CRITICAL: Immediately return the COLLECTION_LIMIT_MESSAGE to MCP client
                    return {
                        content: [{
                            type: "text",
                            text: COLLECTION_LIMIT_MESSAGE
                        }],
                        isError: true
                    };
                }

                console.log(`[INDEX-VALIDATION] ✅  Collection creation validation completed`);
            } catch (validationError: any) {
                // Handle other collection creation errors
                console.error(`[INDEX-VALIDATION] ❌ Collection creation validation failed:`, validationError);
                return {
                    content: [{
                        type: "text",
                        text: `Error validating collection creation: ${validationError.message || validationError}`
                    }],
                    isError: true
                };
            }

            // Add custom extensions if provided
            if (customFileExtensions.length > 0) {
                console.log(`[CUSTOM-EXTENSIONS] Adding ${customFileExtensions.length} custom extensions: ${customFileExtensions.join(', ')}`);
                this.context.addCustomExtensions(customFileExtensions);
            }

            // Add custom ignore patterns if provided (before loading file-based patterns)
            if (customIgnorePatterns.length > 0) {
                console.log(`[IGNORE-PATTERNS] Adding ${customIgnorePatterns.length} custom ignore patterns: ${customIgnorePatterns.join(', ')}`);
                this.context.addCustomIgnorePatterns(customIgnorePatterns);
            }

            // Check current status and log if retrying after failure
            const currentStatus = this.snapshotManager.getCodebaseStatus(absolutePath);
            if (currentStatus === 'indexfailed') {
                const failedInfo = this.snapshotManager.getCodebaseInfo(absolutePath) as any;
                console.log(`[BACKGROUND-INDEX] Retrying indexing for previously failed codebase. Previous error: ${failedInfo?.errorMessage || 'Unknown error'}`);
            }

            // Set to indexing status and save snapshot immediately
            this.snapshotManager.setCodebaseIndexing(absolutePath, 0, snapshotMetadata);
            this.snapshotManager.saveCodebaseSnapshot();

            // Track the codebase path for syncing
            trackCodebasePath(absolutePath);

            // Start background indexing - now safe to proceed
            this.startBackgroundIndexing(absolutePath, forceReindex, splitterType, indexMetadata, snapshotMetadata, repoConfig);

            const pathInfo = codebasePath !== absolutePath
                ? `\nNote: Input path '${codebasePath}' was resolved to absolute path '${absolutePath}'`
                : '';

            const extensionInfo = customFileExtensions.length > 0
                ? `\nUsing ${customFileExtensions.length} custom extensions: ${customFileExtensions.join(', ')}`
                : '';

            const ignoreInfo = customIgnorePatterns.length > 0
                ? `\nUsing ${customIgnorePatterns.length} custom ignore patterns: ${customIgnorePatterns.join(', ')}`
                : '';

            return {
                content: [{
                    type: "text",
                    text: `Started background indexing for codebase '${absolutePath}' using ${splitterType.toUpperCase()} splitter.${pathInfo}${extensionInfo}${ignoreInfo}\n\nIndexing is running in the background. You can search the codebase while indexing is in progress, but results may be incomplete until indexing completes.`
                }]
            };

        } catch (error: any) {
            // Enhanced error handling to prevent MCP service crash
            console.error('Error in handleIndexCodebase:', error);

            // Ensure we always return a proper MCP response, never throw
            return {
                content: [{
                    type: "text",
                    text: `Error starting indexing: ${error.message || error}`
                }],
                isError: true
            };
        }
    }

    private async startBackgroundIndexing(
        codebasePath: string,
        forceReindex: boolean,
        splitterType: string,
        indexMetadata: CodebaseMetadataFields,
        snapshotMetadata: CodebaseMetadataFields,
        repoConfig?: RepositoryConfiguration
    ) {
        const absolutePath = codebasePath;
        let lastSaveTime = 0; // Track last save timestamp

        try {
            console.log(`[BACKGROUND-INDEX] Starting background indexing for: ${absolutePath}`);

            if (forceReindex) {
                console.log(`[BACKGROUND-INDEX] ℹ️  Force reindex mode - collection was already cleared during validation`);
            }

            let contextForThisTask = this.context;
            if (splitterType !== 'ast') {
                console.warn(`[BACKGROUND-INDEX] Non-AST splitter '${splitterType}' requested; falling back to AST splitter`);
            }

            await this.context.getLoadedIgnorePatterns(absolutePath);

            const { FileSynchronizer } = await import("@zilliz/claude-context-core");
            const ignorePatterns = this.context.getIgnorePatterns() || [];
            console.log(`[BACKGROUND-INDEX] Using ignore patterns: ${ignorePatterns.join(', ')}`);
            const synchronizer = new FileSynchronizer(absolutePath, ignorePatterns);
            await synchronizer.initialize();

            await this.context.getPreparedCollection(absolutePath);
            const collectionName = this.context.getCollectionName(absolutePath);
            this.context.setSynchronizer(collectionName, synchronizer);
            if (contextForThisTask !== this.context) {
                contextForThisTask.setSynchronizer(collectionName, synchronizer);
            }

            console.log(`[BACKGROUND-INDEX] Starting indexing with ${splitterType} splitter for: ${absolutePath}`);

            const embeddingProvider = this.context.getEmbedding();
            console.log(`[BACKGROUND-INDEX] 🧠 Using embedding provider: ${embeddingProvider.getProvider()} with dimension: ${embeddingProvider.getDimension()}`);

            console.log(`[BACKGROUND-INDEX] 🚀 Beginning codebase indexing process...`);
            const chunkMetadata: IndexingContextMetadata = { ...indexMetadata };
            const stats = await contextForThisTask.indexCodebase(absolutePath, (progress) => {
                this.snapshotManager.setCodebaseIndexing(absolutePath, progress.percentage, snapshotMetadata);

                const currentTime = Date.now();
                if (currentTime - lastSaveTime >= 2000) {
                    this.snapshotManager.saveCodebaseSnapshot();
                    lastSaveTime = currentTime;
                    console.log(`[BACKGROUND-INDEX] 💾 Saved progress snapshot at ${progress.percentage.toFixed(1)}%`);
                }

                console.log(`[BACKGROUND-INDEX] Progress: ${progress.phase} - ${progress.percentage}% (${progress.current}/${progress.total})`);
            }, forceReindex, chunkMetadata);

            console.log(`[BACKGROUND-INDEX] ✅ Indexing completed successfully! Files: ${stats.indexedFiles}, Chunks: ${stats.totalChunks}`);

            this.snapshotManager.setCodebaseIndexed(absolutePath, stats, snapshotMetadata);
            this.indexingStats = { indexedFiles: stats.indexedFiles, totalChunks: stats.totalChunks };

            this.snapshotManager.saveCodebaseSnapshot();

            let branchIndexResults: Array<{ branch: string; stats: { indexedFiles: number; totalChunks: number; status: 'completed' | 'limit_reached' } }> = [];
            const branchScanEnabled = repoConfig ? this.shouldScanBranches(repoConfig) : false;
            if (repoConfig && branchScanEnabled) {
                try {
                    branchIndexResults = await this.indexAdditionalBranches(repoConfig, absolutePath, indexMetadata, snapshotMetadata);
                } catch (branchError) {
                    console.error(`[BACKGROUND-INDEX] Error during additional branch indexing for '${repoConfig.name}':`, branchError);
                }

                if (branchIndexResults.length > 0) {
                    this.snapshotManager.setCodebaseIndexed(absolutePath, stats, snapshotMetadata);
                    this.snapshotManager.saveCodebaseSnapshot();
                }
            }

            let message = `Background indexing completed for '${absolutePath}' using ${splitterType.toUpperCase()} splitter.\nIndexed ${stats.indexedFiles} files, ${stats.totalChunks} chunks.`;
            if (stats.status === 'limit_reached') {
                message += `\n⚠️  Warning: Indexing stopped because the chunk limit (450,000) was reached. The index may be incomplete.`;
            }

            if (branchIndexResults.length > 0) {
                const branchDetails = branchIndexResults.map(({ branch, stats: branchStats }) => {
                    const limitNote = branchStats.status === 'limit_reached' ? ', limit reached' : '';
                    return `${branch} (${branchStats.indexedFiles} files, ${branchStats.totalChunks} chunks${limitNote})`;
                }).join('; ');
                const additionalChunks = branchIndexResults.reduce((sum, item) => sum + item.stats.totalChunks, 0);
                const additionalFiles = branchIndexResults.reduce((sum, item) => sum + item.stats.indexedFiles, 0);
                message += `\n🔁 Indexed additional branches: ${branchDetails}.`;
                message += `\nTotal chunks across indexed branches: ${stats.totalChunks + additionalChunks}.`;
                this.indexingStats = { indexedFiles: stats.indexedFiles + additionalFiles, totalChunks: stats.totalChunks + additionalChunks };
            } else if (branchScanEnabled) {
                message += `\nBranch scanning was enabled, but no additional branches required indexing.`;
            }

            console.log(`[BACKGROUND-INDEX] ${message}`);

        } catch (error: any) {
            console.error(`[BACKGROUND-INDEX] Error during indexing for ${absolutePath}:`, error);

            const lastProgress = this.snapshotManager.getIndexingProgress(absolutePath);
            const errorMessage = error?.message || String(error);
            this.snapshotManager.setCodebaseIndexFailed(absolutePath, errorMessage, lastProgress, snapshotMetadata);
            this.snapshotManager.saveCodebaseSnapshot();

            console.error(`[BACKGROUND-INDEX] Indexing failed for ${absolutePath}: ${errorMessage}`);
        }
    }

    public async handleSearchCode(args: any) {
        const { path: codebasePath, query, limit = 10, extensionFilter } = args;
        const resultLimit = limit || 10;

        try {
            // Sync indexed codebases from cloud first
            await this.syncIndexedCodebasesFromCloud();

            // Force absolute path resolution - warn if relative path provided
            const absolutePath = ensureAbsolutePath(codebasePath);

            // Validate path exists
            if (!fs.existsSync(absolutePath)) {
                return {
                    content: [{
                        type: "text",
                        text: `Error: Path '${absolutePath}' does not exist. Original input: '${codebasePath}'`
                    }],
                    isError: true
                };
            }

            // Check if it's a directory
            const stat = fs.statSync(absolutePath);
            if (!stat.isDirectory()) {
                return {
                    content: [{
                        type: "text",
                        text: `Error: Path '${absolutePath}' is not a directory`
                    }],
                    isError: true
                };
            }

            trackCodebasePath(absolutePath);

            // Check if this codebase is indexed or being indexed
            const isIndexed = this.snapshotManager.getIndexedCodebases().includes(absolutePath);
            const isIndexing = this.snapshotManager.getIndexingCodebases().includes(absolutePath);

            if (!isIndexed && !isIndexing) {
                return {
                    content: [{
                        type: "text",
                        text: `Error: Codebase '${absolutePath}' is not indexed. Please index it first using the index_codebase tool.`
                    }],
                    isError: true
                };
            }

            // Show indexing status if codebase is being indexed
            let indexingStatusMessage = '';
            if (isIndexing) {
                indexingStatusMessage = `\n⚠️  **Indexing in Progress**: This codebase is currently being indexed in the background. Search results may be incomplete until indexing completes.`;
            }

            console.log(`[SEARCH] Searching in codebase: ${absolutePath}`);
            console.log(`[SEARCH] Query: "${query}"`);
            console.log(`[SEARCH] Indexing status: ${isIndexing ? 'In Progress' : 'Completed'}`);

            // Log embedding provider information before search
            const embeddingProvider = this.context.getEmbedding();
            console.log(`[SEARCH] 🧠 Using embedding provider: ${embeddingProvider.getProvider()} for search`);
            console.log(`[SEARCH] 🔍 Generating embeddings for query using ${embeddingProvider.getProvider()}...`);

            // Build filter expression from extensionFilter list
            let filterExpr: string | undefined = undefined;
            if (Array.isArray(extensionFilter) && extensionFilter.length > 0) {
                const cleaned = extensionFilter
                    .filter((v: any) => typeof v === 'string')
                    .map((v: string) => v.trim())
                    .filter((v: string) => v.length > 0);
                const invalid = cleaned.filter((e: string) => !(e.startsWith('.') && e.length > 1 && !/\s/.test(e)));
                if (invalid.length > 0) {
                    return {
                        content: [{ type: 'text', text: `Error: Invalid file extensions in extensionFilter: ${JSON.stringify(invalid)}. Use proper extensions like '.ts', '.py'.` }],
                        isError: true
                    };
                }
                const quoted = cleaned.map((e: string) => `'${e}'`).join(', ');
                filterExpr = `fileExtension in [${quoted}]`;
            }

            // Search in the specified codebase
            const searchResults = await this.context.semanticSearch(
                absolutePath,
                query,
                Math.min(resultLimit, 50),
                0.3,
                filterExpr
            );

            console.log(`[SEARCH] ✅ Search completed! Found ${searchResults.length} results using ${embeddingProvider.getProvider()} embeddings`);

            if (searchResults.length === 0) {
                let noResultsMessage = `No results found for query: "${query}" in codebase '${absolutePath}'`;
                if (isIndexing) {
                    noResultsMessage += `\n\nNote: This codebase is still being indexed. Try searching again after indexing completes, or the query may not match any indexed content.`;
                }
                return {
                    content: [{
                        type: "text",
                        text: noResultsMessage
                    }]
                };
            }

            // Format results
            const formattedResults = searchResults.map((result: any, index: number) => {
                const location = `${result.relativePath}:${result.startLine}-${result.endLine}`;
                const context = truncateContent(result.content, 5000);
                const codebaseInfo = path.basename(absolutePath);

                return `${index + 1}. Code snippet (${result.language}) [${codebaseInfo}]\n` +
                    `   Location: ${location}\n` +
                    `   Rank: ${index + 1}\n` +
                    `   Context: \n\`\`\`${result.language}\n${context}\n\`\`\`\n`;
            }).join('\n');

            let resultMessage = `Found ${searchResults.length} results for query: "${query}" in codebase '${absolutePath}'${indexingStatusMessage}\n\n${formattedResults}`;

            if (isIndexing) {
                resultMessage += `\n\n💡 **Tip**: This codebase is still being indexed. More results may become available as indexing progresses.`;
            }

            return {
                content: [{
                    type: "text",
                    text: resultMessage
                }]
            };
        } catch (error) {
            // Check if this is the collection limit error
            // Handle both direct string throws and Error objects containing the message
            const errorMessage = typeof error === 'string' ? error : (error instanceof Error ? error.message : String(error));

            if (errorMessage === COLLECTION_LIMIT_MESSAGE || errorMessage.includes(COLLECTION_LIMIT_MESSAGE)) {
                // Return the collection limit message as a successful response
                // This ensures LLM treats it as final answer, not as retryable error
                return {
                    content: [{
                        type: "text",
                        text: COLLECTION_LIMIT_MESSAGE
                    }]
                };
            }

            return {
                content: [{
                    type: "text",
                    text: `Error searching code: ${errorMessage} Please check if the codebase has been indexed first.`
                }],
                isError: true
            };
        }
    }

    public async handleRepoSearch(args: any) {
        const { repo: repoNameInput, branch: branchInput, baseBranch: baseBranchInput, query, limit, path: scopePath } = args || {};

        if (typeof query !== 'string' || query.trim().length === 0) {
            return {
                content: [{
                    type: "text",
                    text: "Error: Query text is required for repo.search."
                }],
                isError: true
            };
        }

        let repoConfig: RepositoryConfiguration | undefined;

        if (typeof repoNameInput === 'string' && repoNameInput.trim().length > 0) {
            repoConfig = this.getRepositoryConfigByName(repoNameInput.trim());
        }

        if (!repoConfig && typeof scopePath === 'string' && scopePath.trim().length > 0) {
            repoConfig = this.resolveRepositoryForPath(scopePath.trim());
        }

        if (!repoConfig && this.config.defaultRepo) {
            repoConfig = this.getRepositoryConfigByName(this.config.defaultRepo);
        }

        if (!repoConfig && this.config.repositories.length === 1) {
            repoConfig = this.config.repositories[0];
        }

        if (!repoConfig) {
            return {
                content: [{
                    type: "text",
                    text: "Error: Unable to determine repository. Provide a repo name or configure repositories via configuration."
                }],
                isError: true
            };
        }

        const repoPath = ensureAbsolutePath(repoConfig.path);
        if (!fs.existsSync(repoPath)) {
            return {
                content: [{
                    type: "text",
                    text: `Error: Repository path '${repoPath}' does not exist. Check your MCP configuration.`
                }],
                isError: true
            };
        }

        trackCodebasePath(repoPath);

        let pathScopeRelative: string | undefined;
        if (typeof scopePath === 'string' && scopePath.trim().length > 0) {
            const providedScope = scopePath.trim();
            const absoluteScope = path.isAbsolute(providedScope)
                ? providedScope
                : path.join(repoPath, providedScope);
            const normalizedScope = path.resolve(absoluteScope);
            if (!normalizedScope.startsWith(repoPath)) {
                return {
                    content: [{
                        type: "text",
                        text: `Error: Path scope '${providedScope}' is outside of repository '${repoConfig.name}'.`
                    }],
                    isError: true
                };
            }
            if (!fs.existsSync(normalizedScope)) {
                return {
                    content: [{
                        type: "text",
                        text: `Error: Path scope '${normalizedScope}' does not exist within repository '${repoConfig.name}'.`
                    }],
                    isError: true
                };
            }
            pathScopeRelative = path.relative(repoPath, normalizedScope) || '.';
        }

        const status = this.snapshotManager.getCodebaseStatus(repoPath);
        const info = this.snapshotManager.getCodebaseInfo(repoPath);
        if (status === 'not_found') {
            return {
                content: [{
                    type: "text",
                    text: `Error: Repository '${repoConfig.name}' at '${repoPath}' is not indexed. Use index_codebase before calling repo.search.`
                }],
                isError: true
            };
        }

        if (status === 'indexfailed') {
            const failureReason = info && 'errorMessage' in info ? (info as any).errorMessage : 'Unknown indexing failure';
            return {
                content: [{
                    type: "text",
                    text: `Error: Repository '${repoConfig.name}' indexing failed previously: ${failureReason}. Please re-run index_codebase.`
                }],
                isError: true
            };
        }

        const limitValue = this.sanitizeLimit(limit, 10);
        const isIndexing = status === 'indexing';

        const metadataKey = repoPath;
        let metadata = this.indexingMetadataCache.get(metadataKey);
        if (!metadata) {
            metadata = await this.buildIndexMetadata(repoPath, repoConfig);
            this.cacheIndexingMetadata(repoPath, metadata);
        }

        const repoName = metadata.repo || repoConfig.name;
        const resolvedBranch = typeof branchInput === 'string' && branchInput.trim().length > 0
            ? branchInput.trim()
            : metadata.branch || repoConfig.currentBranch || undefined;
        const resolvedBaseBranch = typeof baseBranchInput === 'string' && baseBranchInput.trim().length > 0
            ? baseBranchInput.trim()
            : metadata.baseBranch || repoConfig.baseBranch || this.config.defaultBaseBranch || metadata.branch;

        const headerLines: string[] = [
            `🔍 repo.search results for "${query}" in repository '${repoName}' (${repoPath}).`
        ];
        if (resolvedBranch) {
            const baseInfo = resolvedBaseBranch && resolvedBaseBranch !== resolvedBranch
                ? ` (base: ${resolvedBaseBranch})`
                : '';
            headerLines.push(`Current branch: ${resolvedBranch}${baseInfo}`);
        } else if (resolvedBaseBranch) {
            headerLines.push(`Base branch: ${resolvedBaseBranch}`);
        }
        if (pathScopeRelative && pathScopeRelative !== '.') {
            headerLines.push(`Path scope: ${pathScopeRelative}`);
        }
        if (isIndexing) {
            headerLines.push('⚠️ Indexing is currently in progress. Results may be incomplete.');
        }

        const sections: string[] = [headerLines.join('\n')];

        const seen = new Set<string>();
        const primaryFilterRaw = this.buildFilterExpression(repoName, resolvedBranch);
        const primaryFilter = primaryFilterRaw.trim().length > 0 ? primaryFilterRaw : undefined;
        const primaryRaw = await this.context.semanticSearch(repoPath, query, limitValue, 0.3, primaryFilter);
        const primaryResults = this.dedupeResults(this.applyPathScope(primaryRaw, pathScopeRelative), seen).slice(0, limitValue);

        const branchLabel = resolvedBranch || 'current branch';
        if (primaryResults.length > 0) {
            sections.push(`Current branch (${branchLabel}) results:\n${this.formatDetailedResults(primaryResults)}`);
        } else if (resolvedBranch) {
            sections.push(`No matches found on branch ${resolvedBranch}.`);
        }

        let otherResults: SemanticSearchResult[] = [];
        if (primaryResults.length < limitValue) {
            const excludeBranches = resolvedBranch ? [resolvedBranch] : [];
            let otherFilterRaw = this.buildFilterExpression(repoName, undefined, excludeBranches);
            if (otherFilterRaw.trim().length === 0 && repoName) {
                otherFilterRaw = this.buildFilterExpression(repoName);
            }
            const otherFilter = otherFilterRaw.trim().length > 0 ? otherFilterRaw : undefined;
            const otherRaw = await this.context.semanticSearch(repoPath, query, limitValue, 0.3, otherFilter);
            const scopedOther = this.applyPathScope(otherRaw, pathScopeRelative).filter(result => !resolvedBranch || result.branch !== resolvedBranch);
            otherResults = this.dedupeResults(scopedOther, seen).slice(0, limitValue);
        }

        const otherBranchOrder: string[] = [];
        const otherBranchGroups: Map<string, SemanticSearchResult[]> = new Map();
        for (const result of otherResults) {
            const branchName = result.branch || 'unknown';
            if (!otherBranchGroups.has(branchName)) {
                otherBranchGroups.set(branchName, []);
                otherBranchOrder.push(branchName);
            }
            otherBranchGroups.get(branchName)!.push(result);
        }

        if (otherBranchOrder.length > 0) {
            const branchSections = otherBranchOrder.map(branch => `Branch ${branch} results:\n${this.formatDetailedResults(otherBranchGroups.get(branch)!)}`);
            sections.push(['Other branch matches (same repository):', ...branchSections].join('\n\n'));
        }

        let fallbackResults: SemanticSearchResult[] = [];
        if (primaryResults.length === 0 && otherBranchOrder.length === 0) {
            const fallbackFilterRaw = repoName ? this.buildFilterExpression(repoName) : '';
            const fallbackFilter = fallbackFilterRaw.trim().length > 0 ? fallbackFilterRaw : undefined;
            const fallbackRaw = await this.context.semanticSearch(repoPath, query, limitValue, 0.3, fallbackFilter);
            fallbackResults = this.dedupeResults(this.applyPathScope(fallbackRaw, pathScopeRelative), seen).slice(0, limitValue);
        }

        if (fallbackResults.length > 0) {
            sections.push(`Fallback (all branches) results:\n${this.formatDetailedResults(fallbackResults, true)}`);
        }

        if (primaryResults.length === 0 && otherBranchOrder.length === 0 && fallbackResults.length === 0) {
            let noResultsMessage = `No matches found for "${query}" in repository '${repoName}'.`;
            if (isIndexing) {
                noResultsMessage += ' Indexing is still running; try again after it completes.';
            } else {
                noResultsMessage += ' Consider re-indexing or broadening the query.';
            }
            sections.push(noResultsMessage);
        }

        const message = sections.filter(section => section.trim().length > 0).join('\n\n');
        return {
            content: [{
                type: "text",
                text: message
            }]
        };
    }

    public async handleRepoListBranches(args: any) {
        const { repo: repoNameInput, includeRemote } = args || {};

        let repoConfig: RepositoryConfiguration | undefined;

        if (typeof repoNameInput === 'string' && repoNameInput.trim().length > 0) {
            repoConfig = this.getRepositoryConfigByName(repoNameInput.trim());
        }

        if (!repoConfig && this.config.defaultRepo) {
            repoConfig = this.getRepositoryConfigByName(this.config.defaultRepo);
        }

        if (!repoConfig && this.config.repositories.length === 1) {
            repoConfig = this.config.repositories[0];
        }

        if (!repoConfig) {
            return {
                content: [{
                    type: "text",
                    text: "Error: Unable to determine repository. Provide a repo name or configure repositories via configuration."
                }],
                isError: true
            };
        }

        const repoPath = ensureAbsolutePath(repoConfig.path);
        if (!fs.existsSync(repoPath)) {
            return {
                content: [{
                    type: "text",
                    text: `Error: Repository path '${repoPath}' does not exist. Check your MCP configuration.`
                }],
                isError: true
            };
        }

        const includeRemoteFlag = typeof includeRemote === 'string'
            ? ['true', '1', 'yes', 'on'].includes(includeRemote.toLowerCase())
            : Boolean(includeRemote);

        try {
            const ingestor = this.getBranchIngestorForRepo(repoConfig);
            const [branches, currentBranch, baseBranch] = await Promise.all([
                ingestor.listBranches(includeRemoteFlag),
                ingestor.getCurrentBranch(),
                ingestor.getBaseBranch()
            ]);

            if (branches.length === 0) {
                return {
                    content: [{
                        type: "text",
                        text: `No branches found for repository '${repoConfig.name}'.`
                    }]
                };
            }

            const branchList = branches.map(branch => {
                const markers: string[] = [];
                if (branch === currentBranch) {
                    markers.push('current');
                }
                if (branch === (baseBranch || repoConfig.baseBranch || this.config.defaultBaseBranch)) {
                    markers.push('base');
                }
                return markers.length > 0 ? `${branch} (${markers.join(', ')})` : branch;
            });

            const lines: string[] = [
                `📚 Branches for repository '${repoConfig.name}' (${repoPath}):`,
                `Current branch: ${currentBranch || repoConfig.currentBranch || 'unknown'}`,
                `Base branch: ${baseBranch || repoConfig.baseBranch || this.config.defaultBaseBranch || 'unknown'}`,
                includeRemoteFlag ? 'Including remote branches.' : 'Local branches only.',
                '',
                ...branchList.map(branch => `- ${branch}`)
            ];

            return {
                content: [{
                    type: "text",
                    text: lines.join('\n')
                }]
            };
        } catch (error: any) {
            return {
                content: [{
                    type: "text",
                    text: `Error listing branches for repository '${repoConfig.name}': ${error?.message || error}`
                }],
                isError: true
            };
        }
    }

    public async handleRepoBranchSummary(args: any) {
        const { repo: repoNameInput, branch, baseBranch } = args || {};

        if (typeof branch !== 'string' || branch.trim().length === 0) {
            return {
                content: [{
                    type: "text",
                    text: "Error: 'branch' parameter is required for repo.branchSummary."
                }],
                isError: true
            };
        }

        let repoConfig: RepositoryConfiguration | undefined;

        if (typeof repoNameInput === 'string' && repoNameInput.trim().length > 0) {
            repoConfig = this.getRepositoryConfigByName(repoNameInput.trim());
        }

        if (!repoConfig && this.config.defaultRepo) {
            repoConfig = this.getRepositoryConfigByName(this.config.defaultRepo);
        }

        if (!repoConfig && this.config.repositories.length === 1) {
            repoConfig = this.config.repositories[0];
        }

        if (!repoConfig) {
            return {
                content: [{
                    type: "text",
                    text: "Error: Unable to determine repository. Provide a repo name or configure repositories via configuration."
                }],
                isError: true
            };
        }

        const repoPath = ensureAbsolutePath(repoConfig.path);
        if (!fs.existsSync(repoPath)) {
            return {
                content: [{
                    type: "text",
                    text: `Error: Repository path '${repoPath}' does not exist. Check your MCP configuration.`
                }],
                isError: true
            };
        }

        try {
            const ingestor = this.getBranchIngestorForRepo(repoConfig);
            const summary = await ingestor.summarizeBranch(branch.trim(), baseBranch || repoConfig.baseBranch || this.config.defaultBaseBranch);

            const lines: string[] = [
                `🧾 Branch summary for '${repoConfig.name}:${summary.branch}' (base: ${summary.baseBranch})`,
                `Repository path: ${repoPath}`,
                '',
                `Files changed: ${summary.stats.filesChanged}`,
                `Insertions: ${summary.stats.insertions}`,
                `Deletions: ${summary.stats.deletions}`,
                '',
                summary.summary || 'No diff summary available.'
            ];

            if (summary.changedFiles.length > 0) {
                lines.push('', 'Changed files (status code + path):');
                for (const file of summary.changedFiles) {
                    lines.push(`- ${file}`);
                }
            }

            return {
                content: [{
                    type: "text",
                    text: lines.join('\n')
                }]
            };
        } catch (error: any) {
            return {
                content: [{
                    type: "text",
                    text: `Error generating branch summary for repository '${repoConfig.name}': ${error?.message || error}`
                }],
                isError: true
            };
        }
    }

    public async handleClearIndex(args: any) {
        const { path: codebasePath } = args;

        if (this.snapshotManager.getIndexedCodebases().length === 0 && this.snapshotManager.getIndexingCodebases().length === 0) {
            return {
                content: [{
                    type: "text",
                    text: "No codebases are currently indexed or being indexed."
                }]
            };
        }

        try {
            // Force absolute path resolution - warn if relative path provided
            const absolutePath = ensureAbsolutePath(codebasePath);

            // Validate path exists
            if (!fs.existsSync(absolutePath)) {
                return {
                    content: [{
                        type: "text",
                        text: `Error: Path '${absolutePath}' does not exist. Original input: '${codebasePath}'`
                    }],
                    isError: true
                };
            }

            // Check if it's a directory
            const stat = fs.statSync(absolutePath);
            if (!stat.isDirectory()) {
                return {
                    content: [{
                        type: "text",
                        text: `Error: Path '${absolutePath}' is not a directory`
                    }],
                    isError: true
                };
            }

            // Check if this codebase is indexed or being indexed
            const isIndexed = this.snapshotManager.getIndexedCodebases().includes(absolutePath);
            const isIndexing = this.snapshotManager.getIndexingCodebases().includes(absolutePath);

            if (!isIndexed && !isIndexing) {
                return {
                    content: [{
                        type: "text",
                        text: `Error: Codebase '${absolutePath}' is not indexed or being indexed.`
                    }],
                    isError: true
                };
            }

            console.log(`[CLEAR] Clearing codebase: ${absolutePath}`);

            try {
                await this.context.clearIndex(absolutePath);
                console.log(`[CLEAR] Successfully cleared index for: ${absolutePath}`);
            } catch (error: any) {
                const errorMsg = `Failed to clear ${absolutePath}: ${error.message}`;
                console.error(`[CLEAR] ${errorMsg}`);
                return {
                    content: [{
                        type: "text",
                        text: errorMsg
                    }],
                    isError: true
                };
            }

            // Completely remove the cleared codebase from snapshot
            this.snapshotManager.removeCodebaseCompletely(absolutePath);

            // Reset indexing stats if this was the active codebase
            this.indexingStats = null;

            // Save snapshot after clearing index
            this.snapshotManager.saveCodebaseSnapshot();

            let resultText = `Successfully cleared codebase '${absolutePath}'`;

            const remainingIndexed = this.snapshotManager.getIndexedCodebases().length;
            const remainingIndexing = this.snapshotManager.getIndexingCodebases().length;

            if (remainingIndexed > 0 || remainingIndexing > 0) {
                resultText += `\n${remainingIndexed} other indexed codebase(s) and ${remainingIndexing} indexing codebase(s) remain`;
            }

            return {
                content: [{
                    type: "text",
                    text: resultText
                }]
            };
        } catch (error) {
            // Check if this is the collection limit error
            // Handle both direct string throws and Error objects containing the message
            const errorMessage = typeof error === 'string' ? error : (error instanceof Error ? error.message : String(error));

            if (errorMessage === COLLECTION_LIMIT_MESSAGE || errorMessage.includes(COLLECTION_LIMIT_MESSAGE)) {
                // Return the collection limit message as a successful response
                // This ensures LLM treats it as final answer, not as retryable error
                return {
                    content: [{
                        type: "text",
                        text: COLLECTION_LIMIT_MESSAGE
                    }]
                };
            }

            return {
                content: [{
                    type: "text",
                    text: `Error clearing index: ${errorMessage}`
                }],
                isError: true
            };
        }
    }

    public async handleGetIndexingStatus(args: any) {
        const { path: codebasePath } = args;

        try {
            // Force absolute path resolution
            const absolutePath = ensureAbsolutePath(codebasePath);

            // Validate path exists
            if (!fs.existsSync(absolutePath)) {
                return {
                    content: [{
                        type: "text",
                        text: `Error: Path '${absolutePath}' does not exist. Original input: '${codebasePath}'`
                    }],
                    isError: true
                };
            }

            // Check if it's a directory
            const stat = fs.statSync(absolutePath);
            if (!stat.isDirectory()) {
                return {
                    content: [{
                        type: "text",
                        text: `Error: Path '${absolutePath}' is not a directory`
                    }],
                    isError: true
                };
            }

            // Check indexing status using new status system
            const status = this.snapshotManager.getCodebaseStatus(absolutePath);
            const info = this.snapshotManager.getCodebaseInfo(absolutePath);

            let statusMessage = '';

            switch (status) {
                case 'indexed':
                    if (info && 'indexedFiles' in info) {
                        const indexedInfo = info as any;
                        statusMessage = `✅ Codebase '${absolutePath}' is fully indexed and ready for search.`;
                        statusMessage += `\n📊 Statistics: ${indexedInfo.indexedFiles} files, ${indexedInfo.totalChunks} chunks`;
                        statusMessage += `\n📅 Status: ${indexedInfo.indexStatus}`;
                        statusMessage += `\n🕐 Last updated: ${new Date(indexedInfo.lastUpdated).toLocaleString()}`;
                    } else {
                        statusMessage = `✅ Codebase '${absolutePath}' is fully indexed and ready for search.`;
                    }
                    break;

                case 'indexing':
                    if (info && 'indexingPercentage' in info) {
                        const indexingInfo = info as any;
                        const progressPercentage = indexingInfo.indexingPercentage || 0;
                        statusMessage = `🔄 Codebase '${absolutePath}' is currently being indexed. Progress: ${progressPercentage.toFixed(1)}%`;

                        // Add more detailed status based on progress
                        if (progressPercentage < 10) {
                            statusMessage += ' (Preparing and scanning files...)';
                        } else if (progressPercentage < 100) {
                            statusMessage += ' (Processing files and generating embeddings...)';
                        }
                        statusMessage += `\n🕐 Last updated: ${new Date(indexingInfo.lastUpdated).toLocaleString()}`;
                    } else {
                        statusMessage = `🔄 Codebase '${absolutePath}' is currently being indexed.`;
                    }
                    break;

                case 'indexfailed':
                    if (info && 'errorMessage' in info) {
                        const failedInfo = info as any;
                        statusMessage = `❌ Codebase '${absolutePath}' indexing failed.`;
                        statusMessage += `\n🚨 Error: ${failedInfo.errorMessage}`;
                        if (failedInfo.lastAttemptedPercentage !== undefined) {
                            statusMessage += `\n📊 Failed at: ${failedInfo.lastAttemptedPercentage.toFixed(1)}% progress`;
                        }
                        statusMessage += `\n🕐 Failed at: ${new Date(failedInfo.lastUpdated).toLocaleString()}`;
                        statusMessage += `\n💡 You can retry indexing by running the index_codebase command again.`;
                    } else {
                        statusMessage = `❌ Codebase '${absolutePath}' indexing failed. You can retry indexing.`;
                    }
                    break;

                case 'not_found':
                default:
                    statusMessage = `❌ Codebase '${absolutePath}' is not indexed. Please use the index_codebase tool to index it first.`;
                    break;
            }

            const pathInfo = codebasePath !== absolutePath
                ? `\nNote: Input path '${codebasePath}' was resolved to absolute path '${absolutePath}'`
                : '';

            return {
                content: [{
                    type: "text",
                    text: statusMessage + pathInfo
                }]
            };

        } catch (error: any) {
            return {
                content: [{
                    type: "text",
                    text: `Error getting indexing status: ${error.message || error}`
                }],
                isError: true
            };
        }
    }
} 