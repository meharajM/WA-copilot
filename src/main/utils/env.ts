import { dirname } from "path";
import { fileURLToPath } from "url";
import fixPath from "fix-path";
import * as dotenv from 'dotenv';
import * as path from 'path';
import { app } from "electron";

/**
 * Handle ESM shims and environment fixing
 */
export function initEnv(): void {
  // Fix PATH for macOS/Linux GUI apps so they can find node/npx/python
  fixPath();

  // Load .env from the root directory
  dotenv.config({ path: path.join(app.getAppPath(), '.env') });
  
  // Also check for .env in the parent directory if running in dev (electron-vite structure)
  dotenv.config({ path: path.join(process.cwd(), '.env') });
}

export const __filename = fileURLToPath(import.meta.url);
export const __dirname = dirname(__filename);
