import chalk from 'chalk';
import * as fs from 'fs';
import * as path from 'path';

class Logger {
    /** BOTLAB_LOG_DIR (the server sets <data dir>/logs), else <cwd>/logs */
    private static get logsDir(): string {
        return process.env.BOTLAB_LOG_DIR || path.join(process.cwd(), 'logs');
    }
    private static currentLogFile = '';

    private static getLogFileName(): string {
        const date = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
        return path.join(this.logsDir, `bot-${date}.log`);
    }

    private static ensureLogsDir(): void {
        if (!fs.existsSync(this.logsDir)) {
            fs.mkdirSync(this.logsDir, { recursive: true });
        }
    }

    private static writeToFile(message: string): void {
        try {
            this.ensureLogsDir();
            const logFile = this.getLogFileName();
            const timestamp = new Date().toISOString();
            const logEntry = `[${timestamp}] ${message}\n`;
            fs.appendFileSync(logFile, logEntry, 'utf8');
        } catch (error) {
            // Silently fail to avoid infinite loops
        }
    }

    static header(title: string) {
        console.log('\n' + chalk.cyan('━'.repeat(70)));
        console.log(chalk.cyan.bold(`  ${title}`));
        console.log(chalk.cyan('━'.repeat(70)) + '\n');
        this.writeToFile(`HEADER: ${title}`);
    }

    static info(message: string) {
        console.log(chalk.blue('ℹ'), message);
        this.writeToFile(`INFO: ${message}`);
    }

    static success(message: string) {
        console.log(chalk.green('✓'), message);
        this.writeToFile(`SUCCESS: ${message}`);
    }

    static warning(message: string) {
        console.log(chalk.yellow('⚠'), message);
        this.writeToFile(`WARNING: ${message}`);
    }

    static error(message: string) {
        console.log(chalk.red('✗'), message);
        this.writeToFile(`ERROR: ${message}`);
    }

    static separator() {
        console.log(chalk.dim('─'.repeat(70)));
    }
}

export default Logger;
