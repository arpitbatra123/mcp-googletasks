// src/index.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { google } from "googleapis";
import { OAuth2Client } from "google-auth-library";
import * as http from "http";
import * as net from "net";
import dotenv from "dotenv";
import url from "url";
import { promises as fs } from "fs";
import * as path from "path";
import * as os from "os";

// Load environment variables
dotenv.config({ quiet: true });

// Constants
const SCOPES = ["https://www.googleapis.com/auth/tasks"];
const REDIRECT_PORT = 3000;

// Type definitions
interface StoredCredentials {
  access_token: string;
  refresh_token?: string;
  expiry_date?: number;
  token_type?: string;
  scope?: string;
}

// Environment variable validation
function validateEnvironment(): { clientId: string; clientSecret: string; redirectUri: string } {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI || `http://localhost:${REDIRECT_PORT}/oauth2callback`;

  if (!clientId) {
    throw new Error(
      'Missing required environment variable: GOOGLE_CLIENT_ID\n' +
      'Please set this variable before starting the server.'
    );
  }

  if (!clientSecret) {
    throw new Error(
      'Missing required environment variable: GOOGLE_CLIENT_SECRET\n' +
      'Please set this variable before starting the server.'
    );
  }

  // Validate client ID format (should be reasonably long)
  if (clientId.length < 10) {
    throw new Error('GOOGLE_CLIENT_ID appears to be invalid (too short)');
  }

  // Validate redirect URI format
  try {
    new URL(redirectUri);
  } catch {
    throw new Error(`Invalid redirect URI format: ${redirectUri}`);
  }

  return { clientId, clientSecret, redirectUri };
}

// Validate environment variables at startup
const { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, redirectUri: REDIRECT_URI } = validateEnvironment();

// Create server instance
const server = new McpServer({
  name: "google-tasks",
  version: "1.0.0",
});

// Google OAuth setup
const oauth2Client = new OAuth2Client(
  CLIENT_ID,
  CLIENT_SECRET,
  REDIRECT_URI
);

// Load saved credentials if any
let credentials: StoredCredentials | null = null;

// Get credentials file path
function getCredentialsPath(): string {
  const homeDir = os.homedir();
  const configDir = path.join(homeDir, '.config', 'google-tasks-mcp');
  return path.join(configDir, 'credentials.json');
}

// Save credentials to disk
async function saveCredentials(creds: StoredCredentials): Promise<void> {
  try {
    const credsPath = getCredentialsPath();
    const credsDir = path.dirname(credsPath);
    
    // Ensure directory exists
    await fs.mkdir(credsDir, { recursive: true });
    
    // Save credentials (with restricted permissions)
    await fs.writeFile(credsPath, JSON.stringify(creds, null, 2), { mode: 0o600 });
  } catch (error) {
    console.error('Error saving credentials:', error);
    // Don't throw - authentication should still work even if save fails
  }
}

// Load credentials from disk
async function loadCredentials(): Promise<StoredCredentials | null> {
  try {
    const credsPath = getCredentialsPath();
    const data = await fs.readFile(credsPath, 'utf-8');
    const creds = JSON.parse(data) as StoredCredentials;
    
    // Validate that we have required fields
    if (!creds.access_token) {
      return null;
    }
    
    return creds;
  } catch (error) {
    // File doesn't exist or can't be read - that's okay
    return null;
  }
}

// Initialize credentials on startup
async function initializeCredentials(): Promise<void> {
  const savedCreds = await loadCredentials();
  if (savedCreds) {
    credentials = savedCreds;
    oauth2Client.setCredentials(credentials);
    
    // Try to refresh token if it's expired
    try {
      await ensureValidToken();
      // Save updated credentials if they were refreshed
      if (credentials) {
        await saveCredentials(credentials);
      }
    } catch (error) {
      // Token refresh failed - credentials might be invalid
      // Clear them so user can re-authenticate
      console.error('Failed to refresh token on startup:', error);
      credentials = null;
      // Optionally delete invalid credentials file
      try {
        await fs.unlink(getCredentialsPath());
      } catch {
        // Ignore errors deleting file
      }
    }
  }
}

// HTML sanitization helper
function escapeHtml(unsafe: string): string {
  return unsafe
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// Port availability check
function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(port, () => {
      server.once('close', () => resolve(true));
      server.close();
    });
    server.on('error', () => resolve(false));
  });
}

async function findAvailablePort(startPort: number, maxAttempts = 10): Promise<number> {
  for (let i = 0; i < maxAttempts; i++) {
    const port = startPort + i;
    if (await isPortAvailable(port)) {
      return port;
    }
  }
  throw new Error(`No available port found in range ${startPort}-${startPort + maxAttempts}`);
}

// Token refresh logic
async function ensureValidToken(): Promise<void> {
  if (!credentials) {
    throw new Error('Not authenticated');
  }

  // Check if token is expired or about to expire (within 5 minutes)
  const now = Date.now();
  const expiryBuffer = 5 * 60 * 1000; // 5 minutes

  if (credentials.expiry_date && credentials.expiry_date <= now + expiryBuffer) {
    if (!credentials.refresh_token) {
      throw new Error('Token expired and no refresh token available');
    }

    // Refresh the token
    oauth2Client.setCredentials({
      refresh_token: credentials.refresh_token,
    });

    const { credentials: newCredentials } = await oauth2Client.refreshAccessToken();
    credentials = {
      ...newCredentials,
      refresh_token: credentials.refresh_token, // Preserve refresh token
    } as StoredCredentials;

    oauth2Client.setCredentials(credentials);
    
    // Save refreshed credentials to disk
    await saveCredentials(credentials);
  }
}

// Current port in use (dynamic)
let currentRedirectPort = REDIRECT_PORT;

// Initialize Google Tasks client
const tasks = google.tasks({ version: 'v1', auth: oauth2Client });

// Authentication server reference
let authServer: http.Server | null = null;

// Helper function to check if authenticated
function isAuthenticated() {
  return credentials !== null;
}

// Enhanced Zod validation schemas
const TaskListIdSchema = z.string()
  .min(1, "Task list ID cannot be empty")
  .max(200, "Task list ID too long")
  .regex(/^[a-zA-Z0-9_-]+$/, "Invalid task list ID format");

const TaskIdSchema = z.string()
  .min(1, "Task ID cannot be empty")
  .max(200, "Task ID too long")
  .regex(/^[a-zA-Z0-9_-]+$/, "Invalid task ID format");

const TaskTitleSchema = z.string()
  .min(1, "Task title cannot be empty")
  .max(1024, "Task title exceeds maximum length")
  .trim();

const TaskNotesSchema = z.string()
  .max(8192, "Notes exceed maximum length")
  .optional();

const Rfc3339DateSchema = z.string()
  .regex(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/,
    "Due date must be in RFC 3339 format (e.g., 2025-03-19T12:00:00Z)"
  )
  .refine(
    (date) => !isNaN(Date.parse(date)),
    "Invalid date value"
  )
  .optional();

// Authentication tool
server.registerTool(
  "authenticate",
  {
    title: "Authenticate with Google Tasks",
    description: "Get URL to authenticate with Google Tasks",
    inputSchema: z.object({}),
  },
  async () => {
    // Make sure any previous server is closed
    if (authServer) {
      try {
        authServer.close();
      } catch (error) {
        console.error('Error closing existing auth server:', error);
      }
      authServer = null;
    }

    // Determine port from redirect URI
    const redirectUrl = new URL(REDIRECT_URI);
    const defaultPort = redirectUrl.port ? parseInt(redirectUrl.port, 10) : REDIRECT_PORT;
    
    // Use the configured redirect URI port (no dynamic port changes to avoid OAuth mismatch)
    // If port is in use, it will error when trying to listen, which is acceptable
    currentRedirectPort = defaultPort;

    // Create the temporary HTTP server for OAuth callback
    authServer = http.createServer(async (req, res) => {
      try {
        // Parse the URL to get the authorization code
        const queryParams = url.parse(req.url || '', true).query;
        const code = queryParams.code;
        
        if (code && typeof code === 'string') {
          console.error('✅ Authorization code received');
          
          // Send success response with the code (sanitized)
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(`
            <h1>Authorization Code Received</h1>
            <p>Please copy this code and use it with the 'set-auth-code' tool in Claude:</p>
            <div style="padding: 10px; background-color: #f0f0f0; border: 1px solid #ccc; margin: 20px 0;">
              <code>${escapeHtml(code)}</code>
            </div>
            <p>You can close this window after copying the code.</p>
          `);
          
          // Close the server after a short delay
          setTimeout(() => {
            if (authServer) {
              authServer.close();
              authServer = null;
            }
          }, 60000); // Keep the server alive for 1 minute
        } else {
          res.writeHead(400, { 'Content-Type': 'text/html' });
          res.end(`
            <h1>Authentication Failed</h1>
            <p>No authorization code received.</p>
            <p>Please try again.</p>
          `);
        }
      } catch (error) {
        console.error('Error during authentication:', error);
        res.writeHead(500, { 'Content-Type': 'text/html' });
        const errorMessage = error instanceof Error ? escapeHtml(error.message) : escapeHtml(String(error));
        res.end(`
          <h1>Authentication Error</h1>
          <p>${errorMessage}</p>
        `);
      }
    });

    // Start the server on the configured port
    authServer.listen(currentRedirectPort, () => {
      console.error(`Temporary authentication server running at http://localhost:${currentRedirectPort}/`);
      console.error('Waiting for authentication...');
    });

    // Generate the auth URL using the configured OAuth client (with matching redirect URI)
    const authUrl = oauth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: SCOPES,
      // Force approval prompt to always get a refresh token
      prompt: 'consent'
    });

    return {
      content: [
        {
          type: "text",
          text: `Please visit this URL to authenticate with Google Tasks:\n\n${authUrl}\n\nAfter authenticating, you'll receive a code. Use the 'set-auth-code' tool with that code.`,
        },
      ],
    };
  }
);

// Set authentication code tool
server.registerTool(
  "set-auth-code",
  {
    title: "Set Authentication Code",
    description: "Set the authentication code received from Google OAuth flow",
    inputSchema: z.object({
      code: z.string().min(1, "Code cannot be empty").describe("The authentication code received from Google"),
    }),
  },
  async ({ code }: { code: string }) => {
    try {
      const { tokens } = await oauth2Client.getToken(code);
      oauth2Client.setCredentials(tokens);
      
      // Store tokens in memory with proper typing
      credentials = tokens as StoredCredentials;
      
      // Save credentials to disk for persistence
      await saveCredentials(credentials);
      
      // Close auth server if it's still running
      if (authServer) {
        try {
          authServer.close();
        } catch (error) {
          console.error('Error closing auth server:', error);
        }
        authServer = null;
      }
      
      return {
        content: [
          {
            type: "text",
            text: "Authentication successful! You can now use the Google Tasks tools.",
          },
        ],
      };
    } catch (error) {
      console.error('Error retrieving access token:', error);
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Authentication failed: ${error}`,
          },
        ],
      };
    }
  }
);

// Task List Tools
// 1. List all task lists
const listTasklistsSchema = z.object({});
server.registerTool(
  "list-tasklists",
  {
    title: "List Task Lists",
    description: "List all task lists",
    inputSchema: listTasklistsSchema,
  },
  async (args: z.infer<typeof listTasklistsSchema>) => {
    if (!isAuthenticated()) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: "Not authenticated. Please use the 'authenticate' tool first.",
          },
        ],
      };
    }

    try {
      await ensureValidToken();
      const response = await tasks.tasklists.list();
      const taskLists = response.data.items || [];

      if (taskLists.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "No task lists found.",
            },
          ],
        };
      }

      const formattedLists = taskLists.map((list) => ({
        id: list.id,
        title: list.title,
        updated: list.updated,
      }));

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(formattedLists, null, 2),
          },
        ],
      };
    } catch (error) {
      console.error("Error listing task lists:", error);
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Error listing task lists: ${error}`,
          },
        ],
      };
    }
  }
);

// 2. Get task list by ID
const getTasklistSchema = z.object({
  tasklist: TaskListIdSchema.describe("Task list ID"),
});
server.registerTool(
  "get-tasklist",
  {
    title: "Get Task List",
    description: "Get a task list by ID",
    inputSchema: getTasklistSchema,
  },
  async (args: z.infer<typeof getTasklistSchema>) => {
    if (!isAuthenticated()) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: "Not authenticated. Please use the 'authenticate' tool first.",
          },
        ],
      };
    }

    try {
      await ensureValidToken();
      const response = await tasks.tasklists.get({
        tasklist: args.tasklist,
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(response.data, null, 2),
          },
        ],
      };
    } catch (error) {
      console.error("Error getting task list:", error);
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Error getting task list: ${error}`,
          },
        ],
      };
    }
  }
);

// 3. Create a new task list
const createTasklistSchema = z.object({
  title: TaskTitleSchema.describe("Title of the new task list"),
});
server.registerTool(
  "create-tasklist",
  {
    title: "Create Task List",
    description: "Create a new task list",
    inputSchema: createTasklistSchema,
  },
  async (args: z.infer<typeof createTasklistSchema>) => {
    if (!isAuthenticated()) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: "Not authenticated. Please use the 'authenticate' tool first.",
          },
        ],
      };
    }

    try {
      await ensureValidToken();
      const response = await tasks.tasklists.insert({
        requestBody: {
          title: args.title,
        },
      });

      return {
        content: [
          {
            type: "text",
            text: `Task list created successfully:\n\n${JSON.stringify(
              response.data,
              null,
              2
            )}`,
          },
        ],
      };
    } catch (error) {
      console.error("Error creating task list:", error);
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Error creating task list: ${error}`,
          },
        ],
      };
    }
  }
);

// 4. Update a task list
const updateTasklistSchema = z.object({
  tasklist: TaskListIdSchema.describe("Task list ID"),
  title: TaskTitleSchema.describe("New title for the task list"),
});
server.registerTool(
  "update-tasklist",
  {
    title: "Update Task List",
    description: "Update an existing task list",
    inputSchema: updateTasklistSchema,
  },
  async (args: z.infer<typeof updateTasklistSchema>) => {
    if (!isAuthenticated()) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: "Not authenticated. Please use the 'authenticate' tool first.",
          },
        ],
      };
    }

    try {
      await ensureValidToken();
      
      // Fetch current task list to preserve all fields (required fields like id, etag, etc.)
      const currentTaskList = await tasks.tasklists.get({
        tasklist: args.tasklist,
      });

      // Prepare the update request, preserving existing fields
      const requestBody = {
        ...currentTaskList.data,
        title: args.title,
      };

      const response = await tasks.tasklists.update({
        tasklist: args.tasklist,
        requestBody,
      });

      return {
        content: [
          {
            type: "text",
            text: `Task list updated successfully:\n\n${JSON.stringify(
              response.data,
              null,
              2
            )}`,
          },
        ],
      };
    } catch (error) {
      console.error("Error updating task list:", error);
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Error updating task list: ${error}`,
          },
        ],
      };
    }
  }
);

// 5. Delete a task list
const deleteTasklistSchema = z.object({
  tasklist: TaskListIdSchema.describe("Task list ID to delete"),
});
server.registerTool(
  "delete-tasklist",
  {
    title: "Delete Task List",
    description: "Delete a task list",
    inputSchema: deleteTasklistSchema,
  },
  async (args: z.infer<typeof deleteTasklistSchema>) => {
    if (!isAuthenticated()) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: "Not authenticated. Please use the 'authenticate' tool first.",
          },
        ],
      };
    }

    try {
      await ensureValidToken();
      await tasks.tasklists.delete({
        tasklist: args.tasklist,
      });

      return {
        content: [
          {
            type: "text",
            text: `Task list with ID '${args.tasklist}' was successfully deleted.`,
          },
        ],
      };
    } catch (error) {
      console.error("Error deleting task list:", error);
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Error deleting task list: ${error}`,
          },
        ],
      };
    }
  }
);

// Task Tools
// 1. List tasks in a task list
const listTasksSchema = z.object({
  tasklist: TaskListIdSchema.describe("Task list ID"),
  showCompleted: z
    .boolean()
    .optional()
    .describe("Whether to include completed tasks"),
  showHidden: z
    .boolean()
    .optional()
    .describe("Whether to include hidden tasks"),
  showDeleted: z
    .boolean()
    .optional()
    .describe("Whether to include deleted tasks"),
});
server.registerTool(
  "list-tasks",
  {
    title: "List Tasks",
    description: "List all tasks in a task list",
    inputSchema: listTasksSchema,
  },
  async (args: z.infer<typeof listTasksSchema>) => {
    if (!isAuthenticated()) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: "Not authenticated. Please use the 'authenticate' tool first.",
          },
        ],
      };
    }

    try {
      await ensureValidToken();
      const response = await tasks.tasks.list({
        tasklist: args.tasklist,
        showCompleted: args.showCompleted ?? true,
        showHidden: args.showHidden ?? false,
        showDeleted: args.showDeleted ?? false,
      });

      const tasksResponse = response.data.items || [];

      if (tasksResponse.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "No tasks found in this list.",
            },
          ],
        };
      }

      const formattedTasks = tasksResponse.map((task) => ({
        id: task.id,
        title: task.title,
        status: task.status,
        due: task.due,
        notes: task.notes,
        completed: task.completed,
      }));

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(formattedTasks, null, 2),
          },
        ],
      };
    } catch (error) {
      console.error("Error listing tasks:", error);
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Error listing tasks: ${error}`,
          },
        ],
      };
    }
  }
);

// 2. Get a specific task
const getTaskSchema = z.object({
  tasklist: TaskListIdSchema.describe("Task list ID"),
  task: TaskIdSchema.describe("Task ID"),
});
server.registerTool(
  "get-task",
  {
    title: "Get Task",
    description: "Get a specific task by ID",
    inputSchema: getTaskSchema,
  },
  async (args: z.infer<typeof getTaskSchema>) => {
    if (!isAuthenticated()) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: "Not authenticated. Please use the 'authenticate' tool first.",
          },
        ],
      };
    }

    try {
      await ensureValidToken();
      const response = await tasks.tasks.get({
        tasklist: args.tasklist,
        task: args.task,
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(response.data, null, 2),
          },
        ],
      };
    } catch (error) {
      console.error("Error getting task:", error);
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Error getting task: ${error}`,
          },
        ],
      };
    }
  }
);

// 3. Create a new task
const createTaskSchema = z.object({
  tasklist: TaskListIdSchema.describe("Task list ID"),
  title: TaskTitleSchema.describe("Title of the task"),
  notes: TaskNotesSchema.describe("Notes for the task"),
  due: Rfc3339DateSchema.describe("Due date in RFC 3339 format (e.g., 2025-03-19T12:00:00Z)"),
});
server.registerTool(
  "create-task",
  {
    title: "Create Task",
    description: "Create a new task in a task list",
    inputSchema: createTaskSchema,
  },
  async (args: z.infer<typeof createTaskSchema>) => {
    if (!isAuthenticated()) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: "Not authenticated. Please use the 'authenticate' tool first.",
          },
        ],
      };
    }

    try {
      await ensureValidToken();
      const requestBody: {
        title: string;
        status: string;
        notes?: string;
        due?: string;
      } = {
        title: args.title,
        status: "needsAction",
      };

      if (args.notes) requestBody.notes = args.notes;
      if (args.due) requestBody.due = args.due;

      const response = await tasks.tasks.insert({
        tasklist: args.tasklist,
        requestBody,
      });

      return {
        content: [
          {
            type: "text",
            text: `Task created successfully:\n\n${JSON.stringify(
              response.data,
              null,
              2
            )}`,
          },
        ],
      };
    } catch (error) {
      console.error("Error creating task:", error);
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Error creating task: ${error}`,
          },
        ],
      };
    }
  }
);

// 4. Update a task
const updateTaskSchema = z.object({
  tasklist: TaskListIdSchema.describe("Task list ID"),
  task: TaskIdSchema.describe("Task ID"),
  title: TaskTitleSchema.optional().describe("New title for the task"),
  notes: TaskNotesSchema.describe("New notes for the task"),
  status: z
    .enum(["needsAction", "completed"])
    .optional()
    .describe("Status of the task"),
  due: Rfc3339DateSchema.describe("Due date in RFC 3339 format (e.g., 2025-03-19T12:00:00Z)"),
});
server.registerTool(
  "update-task",
  {
    title: "Update Task",
    description: "Update an existing task",
    inputSchema: updateTaskSchema,
  },
  async (args: z.infer<typeof updateTaskSchema>) => {
    if (!isAuthenticated()) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: "Not authenticated. Please use the 'authenticate' tool first.",
          },
        ],
      };
    }

    try {
      await ensureValidToken();
      
      // Fetch current task to preserve all fields (required fields like id, etag, etc.)
      // Note: Google Tasks API update method accepts partial updates, but we fetch first
      // to ensure we preserve fields like id, etag, and position that aren't in the update schema
      const currentTask = await tasks.tasks.get({
        tasklist: args.tasklist,
        task: args.task,
      });

      // Prepare the update request, preserving existing fields
      const requestBody = {
        ...currentTask.data,
      };

      if (args.title !== undefined) requestBody.title = args.title;
      if (args.notes !== undefined) requestBody.notes = args.notes;
      if (args.status !== undefined) requestBody.status = args.status;
      if (args.due !== undefined) requestBody.due = args.due;

      const response = await tasks.tasks.update({
        tasklist: args.tasklist,
        task: args.task,
        requestBody,
      });

      return {
        content: [
          {
            type: "text",
            text: `Task updated successfully:\n\n${JSON.stringify(
              response.data,
              null,
              2
            )}`,
          },
        ],
      };
    } catch (error) {
      console.error("Error updating task:", error);
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Error updating task: ${error}`,
          },
        ],
      };
    }
  }
);

// 5. Delete a task
const deleteTaskSchema = z.object({
  tasklist: TaskListIdSchema.describe("Task list ID"),
  task: TaskIdSchema.describe("Task ID to delete"),
});
server.registerTool(
  "delete-task",
  {
    title: "Delete Task",
    description: "Delete a task",
    inputSchema: deleteTaskSchema,
  },
  async (args: z.infer<typeof deleteTaskSchema>) => {
    if (!isAuthenticated()) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: "Not authenticated. Please use the 'authenticate' tool first.",
          },
        ],
      };
    }

    try {
      await ensureValidToken();
      await tasks.tasks.delete({
        tasklist: args.tasklist,
        task: args.task,
      });

      return {
        content: [
          {
            type: "text",
            text: `Task with ID '${args.task}' was successfully deleted.`,
          },
        ],
      };
    } catch (error) {
      console.error("Error deleting task:", error);
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Error deleting task: ${error}`,
          },
        ],
      };
    }
  }
);

// 6. Complete a task
const completeTaskSchema = z.object({
  tasklist: TaskListIdSchema.describe("Task list ID"),
  task: TaskIdSchema.describe("Task ID to mark as completed"),
});
server.registerTool(
  "complete-task",
  {
    title: "Complete Task",
    description: "Mark a task as completed",
    inputSchema: completeTaskSchema,
  },
  async (args: z.infer<typeof completeTaskSchema>) => {
    if (!isAuthenticated()) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: "Not authenticated. Please use the 'authenticate' tool first.",
          },
        ],
      };
    }

    try {
      await ensureValidToken();
      // Get the current task
      const currentTask = await tasks.tasks.get({
        tasklist: args.tasklist,
        task: args.task,
      });

      // Update the status to completed
      const requestBody = {
        ...currentTask.data,
        status: "completed",
        completed: new Date().toISOString(),
      };

      const response = await tasks.tasks.update({
        tasklist: args.tasklist,
        task: args.task,
        requestBody,
      });

      return {
        content: [
          {
            type: "text",
            text: `Task marked as completed:\n\n${JSON.stringify(
              response.data,
              null,
              2
            )}`,
          },
        ],
      };
    } catch (error) {
      console.error("Error completing task:", error);
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Error completing task: ${error}`,
          },
        ],
      };
    }
  }
);

// 7. Move a task
const moveTaskSchema = z.object({
  tasklist: TaskListIdSchema.describe("Task list ID"),
  task: TaskIdSchema.describe("Task ID to move"),
  parent: TaskIdSchema.optional().describe("Optional new parent task ID"),
  previous: TaskIdSchema
    .optional()
    .describe("Optional previous sibling task ID"),
});
server.registerTool(
  "move-task",
  {
    title: "Move Task",
    description: "Move a task to another position",
    inputSchema: moveTaskSchema,
  },
  async (args: z.infer<typeof moveTaskSchema>) => {
    if (!isAuthenticated()) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: "Not authenticated. Please use the 'authenticate' tool first.",
          },
        ],
      };
    }

    try {
      await ensureValidToken();
      const moveParams: {
        tasklist: string;
        task: string;
        parent?: string;
        previous?: string;
      } = {
        tasklist: args.tasklist,
        task: args.task,
      };

      if (args.parent !== undefined) moveParams.parent = args.parent;
      if (args.previous !== undefined) moveParams.previous = args.previous;

      const response = await tasks.tasks.move(moveParams);

      return {
        content: [
          {
            type: "text",
            text: `Task moved successfully:\n\n${JSON.stringify(
              response.data,
              null,
              2
            )}`,
          },
        ],
      };
    } catch (error) {
      console.error("Error moving task:", error);
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Error moving task: ${error}`,
          },
        ],
      };
    }
  }
);

// 8. Clear completed tasks
const clearCompletedTasksSchema = z.object({
  tasklist: TaskListIdSchema.describe("Task list ID"),
});
server.registerTool(
  "clear-completed-tasks",
  {
    title: "Clear Completed Tasks",
    description: "Clear all completed tasks from a task list",
    inputSchema: clearCompletedTasksSchema,
  },
  async (args: z.infer<typeof clearCompletedTasksSchema>) => {
    if (!isAuthenticated()) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: "Not authenticated. Please use the 'authenticate' tool first.",
          },
        ],
      };
    }

    try {
      await ensureValidToken();
      await tasks.tasks.clear({
        tasklist: args.tasklist,
      });

      return {
        content: [
          {
            type: "text",
            text: `All completed tasks in list '${args.tasklist}' have been cleared.`,
          },
        ],
      };
    } catch (error) {
      console.error("Error clearing completed tasks:", error);
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Error clearing completed tasks: ${error}`,
          },
        ],
      };
    }
  }
);

// Graceful shutdown handler
async function gracefulShutdown(signal: string) {
  console.error(`${signal} received; shutting down gracefully`);
  if (authServer) {
    try {
      authServer.close();
      authServer = null;
    } catch (error) {
      console.error('Error closing auth server during shutdown:', error);
    }
  }
  try {
    await server.close();
  } catch (error) {
    console.error('Error closing server during shutdown:', error);
  }
  process.exit(0);
}

// Register shutdown handlers
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

// Start the server
async function main() {
  // Load saved credentials on startup
  await initializeCredentials();
  
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Google Tasks MCP Server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error in main():", error);
  process.exit(1);
});
