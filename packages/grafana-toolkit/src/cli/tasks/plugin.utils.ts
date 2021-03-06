import { Task, TaskRunner } from './task';
import { getPluginJson } from '../../config/utils/pluginValidation';
import { GitHubRelease } from '../utils/githubRelease';
import { getPluginId } from '../../config/utils/getPluginId';
import { getCiFolder } from '../../plugins/env';
import { useSpinner } from '../utils/useSpinner';
import path = require('path');

// @ts-ignore
import execa = require('execa');

interface Command extends Array<any> {}

const releaseNotes = async (): Promise<string> => {
  const { stdout } = await execa.shell(`awk \'BEGIN {FS="##"; RS=""} FNR==3 {print; exit}\' CHANGELOG.md`);
  return stdout;
};

const checkoutBranch = async (branchName: string): Promise<Command> => {
  const currentBranch = await execa.shell(`git rev-parse --abbrev-ref HEAD`);
  const branchesAvailable = await execa.shell(
    `(git branch -a | grep "${branchName}$" | grep -v remote) || echo 'No release found'`
  );

  if (currentBranch.stdout !== branchName) {
    console.log('available', branchesAvailable.stdout.trim());
    if (branchesAvailable.stdout.trim() === branchName) {
      return ['git', ['checkout', branchName]];
    } else {
      return ['git', ['checkout', '-b', branchName]];
    }
  }
  return [];
};

const gitUrlParse = (url: string): { owner: string; name: string } => {
  let matchResult: RegExpMatchArray | null = [];

  if (url.match(/^git@github.com/)) {
    // We have an ssh style url.
    matchResult = url.match(/^git@github.com:(.*?)\/(.*?)\.git/);
  }

  if (url.match(/^https:\/\/github.com\//)) {
    // We have an https style url
    matchResult = url.match(/^https:\/\/github.com\/(.*?)\/(.*?)\/.git/);
  }

  if (matchResult && matchResult.length > 2) {
    return {
      owner: matchResult[1],
      name: matchResult[2],
    };
  }

  throw `Coult not find a suitable git repository. Received [${url}]`;
};

const prepareRelease = useSpinner<any>('Preparing release', async ({ dryrun, verbose }) => {
  const ciDir = getCiFolder();
  const distDir = path.resolve(ciDir, 'dist');
  const distContentDir = path.resolve(distDir, getPluginId());
  const pluginJsonFile = path.resolve(distContentDir, 'plugin.json');
  const pluginJson = getPluginJson(pluginJsonFile);
  const GIT_EMAIL = 'eng@grafana.com';
  const GIT_USERNAME = 'CircleCI Automation';

  const githubPublishScript: Command = [
    ['git', ['config', 'user.email', GIT_EMAIL]],
    ['git', ['config', 'user.name', GIT_USERNAME]],
    await checkoutBranch(`release-${pluginJson.info.version}`),
    ['cp', ['-rf', distContentDir, 'dist']],
    ['git', ['add', '--force', distDir], { dryrun }],
    ['git', ['add', '--force', 'dist'], { dryrun }],
    ['/bin/rm', ['-rf', 'src'], { enterprise: true }],
    [
      'git',
      ['commit', '-m', `automated release ${pluginJson.info.version} [skip ci]`],
      {
        dryrun,
        okOnError: [/nothing to commit/g, /nothing added to commit/g, /no changes added to commit/g],
      },
    ],
    ['git', ['tag', '-f', pluginJson.info.version]],
    ['git', ['push', '-f', 'origin', `release-${pluginJson.info.version}`], { dryrun }],
  ];

  for (let line of githubPublishScript) {
    const opts = line.length === 3 ? line[2] : {};
    const command = line[0];
    const args = line[1];

    try {
      if (verbose) {
        console.log('executing >>', line);
      }

      if (line.length > 0 && line[0].length > 0) {
        if (opts['dryrun']) {
          line[1].push('--dry-run');
        }

        if (pluginJson.enterprise && !opts['enterprise']) {
          continue;
        }

        const { stdout } = await execa(command, args);
        if (verbose) {
          console.log(stdout);
        }
      } else {
        if (verbose) {
          console.log('skipping empty line');
        }
      }
    } catch (ex) {
      const err: string = ex.message;
      if (opts['okOnError'] && Array.isArray(opts['okOnError'])) {
        let trueError = true;
        for (let regex of opts['okOnError']) {
          if (err.match(regex)) {
            trueError = false;
            break;
          }
        }

        if (!trueError) {
          // This is not an error
          continue;
        }
      }
      console.error(err);
      process.exit(-1);
    }
  }
});

interface GithubPublishReleaseOptions {
  commitHash?: string;
  githubToken: string;
  gitRepoOwner: string;
  gitRepoName: string;
}

const createRelease = useSpinner<GithubPublishReleaseOptions>(
  'Creating release',
  async ({ commitHash, githubToken, gitRepoName, gitRepoOwner }) => {
    const gitRelease = new GitHubRelease(githubToken, gitRepoOwner, gitRepoName, await releaseNotes(), commitHash);
    return gitRelease.release();
  }
);

export interface GithubPublishOptions {
  dryrun?: boolean;
  verbose?: boolean;
  commitHash?: string;
  dev?: boolean;
}

const githubPublishRunner: TaskRunner<GithubPublishOptions> = async ({ dryrun, verbose, commitHash }) => {
  if (!process.env['CIRCLE_REPOSITORY_URL']) {
    throw `The release plugin requires you specify the repository url as environment variable CIRCLE_REPOSITORY_URL`;
  }

  if (!process.env['GITHUB_TOKEN']) {
    throw `Github publish requires that you set the environment variable GITHUB_TOKEN to a valid github api token.
    See: https://github.com/settings/tokens for more details.`;
  }

  const parsedUrl = gitUrlParse(process.env['CIRCLE_REPOSITORY_URL']);
  const githubToken = process.env['GITHUB_TOKEN'];

  await prepareRelease({
    dryrun,
    verbose,
  });

  await createRelease({
    commitHash,
    githubToken,
    gitRepoOwner: parsedUrl.owner,
    gitRepoName: parsedUrl.name,
  });
};

export const githubPublishTask = new Task<GithubPublishOptions>('Github Publish', githubPublishRunner);
