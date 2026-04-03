import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.join(__dirname, '..');
const docsDir = path.join(rootDir, 'docs');

const files = [
    { input: 'tester_flow.html', output: 'AIConsumerAgent_Technical_Manual.pdf' },
    { input: 'tester_install.html', output: 'AIConsumerAgent_User_Manual.pdf' }
];

async function generate() {
    console.log('🚀 Starting PDF generation...');
    const browser = await chromium.launch();
    const page = await browser.newPage();

    for (const file of files) {
        const inputPath = path.join(docsDir, file.input);
        const outputPath = path.join(docsDir, file.output);

        if (!fs.existsSync(inputPath)) {
            console.error(`❌ Input file not found: ${inputPath}`);
            continue;
        }

        console.log(`📄 Rendering ${file.input} -> ${file.output}...`);
        await page.goto(`file://${inputPath}`, { waitUntil: 'networkidle' });
        
        await page.pdf({
            path: outputPath,
            format: 'A4',
            printBackground: true,
            margin: { top: '0.4in', right: '0.4in', bottom: '0.4in', left: '0.4in' }
        });

        console.log(`✅ Generated: ${outputPath}`);
    }

    await browser.close();
    console.log('🎉 All PDFs generated successfully!');
}

generate().catch(err => {
    console.error('❌ Error generating PDFs:', err);
    process.exit(1);
});
