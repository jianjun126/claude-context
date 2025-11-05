import { execFile } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';

const execFileAsync = promisify(execFile);

export interface BranchSummaryStats {
    filesChanged: number;
    insertions: number;
    deletions: number;
}

export interface BranchSummaryResult {
    branch: string;
    baseBranch: string;
    summary: string;
    changedFiles: string[];
    stats: BranchSummaryStats;
}

export interface BranchIngestorOptions {
    baseBranch?: string;
}

export class GitBranchIngestor {
    constructor(private readonly repoPath: string, private readonly options: BranchIngestorOptions = {}) {}

    static async resolveRepoRoot(startPath: string): Promise<string | null> {
        try {
            const { stdout } = await execFileAsync('git', ['rev-parse', '--show-toplevel'], { cwd: startPath });
            return stdout.trim();
        } catch (error) {
            console.warn(`[GitBranchIngestor] Failed to resolve repo root from ${startPath}:`, error);
            return null;
        }
    }

    private async runGit(args: string[]): Promise<string> {
        try {
            const { stdout } = await execFileAsync('git', args, { cwd: this.repoPath });
            return stdout.trim();
        } catch (error) {
            console.warn(`[GitBranchIngestor] git ${args.join(' ')} failed in ${this.repoPath}:`, error);
            throw error;
        }
    }

    async listBranches(includeRemote: boolean = false): Promise<string[]> {
        try {
            const args = includeRemote
                ? ['branch', '-a', '--format=%(refname:short)']
                : ['branch', '--format=%(refname:short)'];
            const output = await this.runGit(args);
            const branches = output
                .split(/\r?\n/)
                .map(branch => branch.replace(/^\*\s*/, '').trim())
                .filter(branch => branch.length > 0 && !branch.startsWith('remotes/HEAD'));
            return Array.from(new Set(branches));
        } catch (error) {
            console.warn('[GitBranchIngestor] Unable to list branches:', error);
            return [];
        }
    }

    async getCurrentBranch(): Promise<string | null> {
        try {
            const branch = await this.runGit(['rev-parse', '--abbrev-ref', 'HEAD']);
            return branch === 'HEAD' ? null : branch;
        } catch (error) {
            return null;
        }
    }

    async getBaseBranch(): Promise<string | null> {
        if (this.options.baseBranch) {
            return this.options.baseBranch;
        }

        const preferred = ['main', 'master'];
        try {
            const remoteHead = await this.runGit(['symbolic-ref', 'refs/remotes/origin/HEAD']);
            const parts = remoteHead.split('/');
            if (parts.length > 0) {
                return parts[parts.length - 1];
            }
        } catch (error) {
            // Ignore - fall back to heuristics below
        }

        for (const branch of preferred) {
            try {
                await this.runGit(['rev-parse', '--verify', branch]);
                return branch;
            } catch (error) {
                // Try next
            }
        }

        return null;
    }

    async summarizeBranch(branch: string, baseBranch?: string): Promise<BranchSummaryResult> {
        const resolvedBase = baseBranch || (await this.getBaseBranch()) || 'main';

        let diffStat = '';
        let changedFilesOutput = '';
        let recentCommits = '';

        try {
            diffStat = await this.runGit(['diff', `${resolvedBase}...${branch}`, '--stat']);
        } catch (error) {
            diffStat = '';
        }

        try {
            changedFilesOutput = await this.runGit(['diff', `${resolvedBase}...${branch}`, '--name-status']);
        } catch (error) {
            changedFilesOutput = '';
        }

        try {
            recentCommits = await this.runGit(['log', `${resolvedBase}..${branch}`, '--oneline', '-5']);
        } catch (error) {
            recentCommits = '';
        }

        const changedFiles = changedFilesOutput
            .split(/\r?\n/)
            .map(line => line.trim())
            .filter(line => line.length > 0);

        const stats = this.parseDiffStat(diffStat);

        const summaryParts: string[] = [];
        if (diffStat.trim().length > 0) {
            summaryParts.push(diffStat.trim());
        }
        if (recentCommits.trim().length > 0) {
            summaryParts.push('Recent commits:\n' + recentCommits.trim());
        }

        const summaryText = summaryParts.join('\n\n') || `No differences detected between ${branch} and ${resolvedBase}.`;

        return {
            branch,
            baseBranch: resolvedBase,
            summary: summaryText,
            changedFiles,
            stats,
        };
    }

    async getRelativePath(targetPath: string): Promise<string> {
        const absoluteTarget = path.resolve(targetPath);
        const repoRoot = await GitBranchIngestor.resolveRepoRoot(this.repoPath);
        if (!repoRoot) {
            return absoluteTarget;
        }
        return path.relative(repoRoot, absoluteTarget) || '.';
    }

    private parseDiffStat(statOutput: string): BranchSummaryStats {
        const stats: BranchSummaryStats = {
            filesChanged: 0,
            insertions: 0,
            deletions: 0,
        };

        const lines = statOutput.split(/\r?\n/).map(line => line.trim());
        for (const line of lines) {
            const match = line.match(/(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/i);
            if (match) {
                stats.filesChanged = parseInt(match[1], 10) || 0;
                stats.insertions = match[2] ? parseInt(match[2], 10) : 0;
                stats.deletions = match[3] ? parseInt(match[3], 10) : 0;
                break;
            }
        }

        return stats;
    }
}
