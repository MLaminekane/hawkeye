import { Command } from 'commander';
import { join, dirname } from 'node:path';
import { existsSync } from 'node:fs';
import { Storage } from '@mklamine/hawkeye-core';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpServer } from '../mcp/server.js';

export const mcpCommand = new Command('mcp')
    .description('Start the Hawkeye MCP server (stdio transport for Claude Desktop, Cursor, etc.)')
    .option('--db <path>', 'Path to the Hawkeye database file')
    .action(async (options) => {
        const dbPath = options.db || join(process.cwd(), '.hawkeye', 'traces.db');

        if (!existsSync(dbPath)) {
            // Use stderr — stdout is reserved for JSON-RPC in stdio transport
            console.error(`Error: No database found at ${dbPath}`);
            console.error('Run `hawkeye init` and record a session first.');
            process.exit(1);
        }

        const storage = new Storage(dbPath);
        const cwd = options.db ? dirname(dirname(dbPath)) : process.cwd();
        const server = createMcpServer(storage, cwd);
        const transport = new StdioServerTransport();

        // Graceful shutdown
        process.on('SIGINT', () => {
            storage.close();
            process.exit(0);
        });
        process.on('SIGTERM', () => {
            storage.close();
            process.exit(0);
        });

        console.error('Hawkeye MCP server started (stdio transport)');
        await server.connect(transport);
    });
