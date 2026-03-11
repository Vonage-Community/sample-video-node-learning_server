import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import simpleGit from 'simple-git';
import archiver from 'archiver';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const vcrBuildDir = path.join(__dirname, 'vcr-build');
const releaseDir = path.join(__dirname, 'release');
const repoUrl = 'https://github.com/Vonage-Community/sample-video-node-learning_server.git';

// Check for version argument
const version = process.argv[2];
if (!version) {
  console.error('Error: Version argument is required. Usage: npm run vcrbuild <version>');
  process.exit(1);
}

const zipFileName = `vcr-build-${version}.zip`;

async function runVcrBuild() {
  try {
    // Check if the release file already exists
    if (fs.existsSync(path.join(releaseDir, zipFileName))) {
      console.error(`Error: Release file for version ${version} already exists.`);
      process.exit(1);
    }

    // Create release directory if it doesn't exist
    if (!fs.existsSync(releaseDir)) {
      fs.mkdirSync(releaseDir);
    }

    // Step 1: Delete vcr-build directory if it exists
    if (fs.existsSync(vcrBuildDir)) {
      fs.rmSync(vcrBuildDir, { recursive: true });
    }

    // Step 2: Perform a clean checkout of the repository
    await simpleGit().clone(repoUrl, vcrBuildDir);

    // Step 3: Copy vcr.yml to vcr-build
    const neruFilePath = path.join(vcrBuildDir, 'vcr.yml.dist');
    fs.copyFileSync(neruFilePath, path.join(vcrBuildDir, 'vcr.yml'));
    fs.rmSync(vcrBuildDir + '/.git', { recursive: true })
    fs.rmSync(vcrBuildDir + '/.gitignore')
    fs.rmSync(neruFilePath)

    // Step 4: Create a ZIP file from vcr-build with version name
    await createZipFile(vcrBuildDir, zipFileName);

    console.log(`VCR build process completed successfully. File created: ${zipFileName}`);
  } catch (error) {
    console.error('Error during VCR build process:', error);
  }
}

async function createZipFile(sourceDir, zipFileName) {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(path.join(releaseDir, zipFileName));
    const archive = archiver('zip', { zlib: { level: 9 } });

    output.on('close', () => resolve());
    archive.on('error', (err) => reject(err));

    archive.pipe(output);
    archive.directory(sourceDir, false);
    archive.finalize();
  });
}

runVcrBuild();
