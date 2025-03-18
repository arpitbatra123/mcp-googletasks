// src/index.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { google } from "googleapis";
import { OAuth2Client } from "google-auth-library";
import * as http from "http";
import * as path from "path";
import dotenv from "dotenv";
import url from "url";

// Load environment variables
dotenv.config();

// Constants
const SCOPES = ["https://www.googleapis.com/auth/tasks"];

// Create server instance
const server = new McpServer({
  name: "google-tasks",
  version: "1.0.0",
});


const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URI = 'http://localhost:3000/oauth2callback';
const REDIRECT_PORT = 3000;

// Google OAuth setup
const oauth2Client = new OAuth2Client(
  CLIENT_ID,
  CLIENT_SECRET,
  REDIRECT_URI
);

// Load saved credentials if any
let credentials : any = null;

// Initialize Google Tasks client
const tasks = google.tasks({ version: 'v1', auth: oauth2Client });

// Authentication server reference
let authServer : http.Server | null = null;

// Helper function to check if authenticated
function isAuthenticated() {
  return credentials !== null;
}

// Authentication tool
server.tool(
  "authenticate",
  "Get URL to authenticate with Google Tasks",
  {},
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

    // Create the temporary HTTP server for OAuth callback
    authServer = http.createServer(async (req, res) => {
      try {
        // Parse the URL to get the authorization code
        const queryParams = url.parse(req.url || '', true).query;
        const code = queryParams.code;
        
        if (code) {
          console.error('✅ Authorization code received');
          
          // Send success response with the code
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(`
            <h1>Authorization Code Received</h1>
            <p>Please copy this code and use it with the 'set-auth-code' tool in Claude:</p>
            <div style="padding: 10px; background-color: #f0f0f0; border: 1px solid #ccc; margin: 20px 0;">
              <code>${code}</code>
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
        res.end(`
          <h1>Authentication Error</h1>
          <p>${error instanceof Error ? error.message : String(error)}</p>
        `);
      }
    });

    // Start the server
    authServer.listen(REDIRECT_PORT, () => {
      console.error(`Temporary authentication server running at http://localhost:${REDIRECT_PORT}/`);
      console.error('Waiting for authentication...');
    });

    // Generate the auth URL
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
server.tool(
  "set-auth-code",
  "Set the authentication code received from Google OAuth flow",
  {
    code: z.string().describe("The authentication code received from Google"),
  },
  async ({ code }) => {
    try {
      const { tokens } = await oauth2Client.getToken(code);
      oauth2Client.setCredentials(tokens);
      
      // Store tokens in memory only
      credentials = tokens;
      
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
server.tool("list-tasklists", "List all task lists", {}, async () => {
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
});

// 2. Get task list by ID
server.tool(
  "get-tasklist",
  "Get a task list by ID",
  {
    tasklist: z.string().describe("Task list ID"),
  },
  async ({ tasklist }) => {
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
      const response = await tasks.tasklists.get({
        tasklist,
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
server.tool(
  "create-tasklist",
  "Create a new task list",
  {
    title: z.string().describe("Title of the new task list"),
  },
  async ({ title }) => {
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
      const response = await tasks.tasklists.insert({
        requestBody: {
          title,
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
server.tool(
  "update-tasklist",
  "Update an existing task list",
  {
    tasklist: z.string().describe("Task list ID"),
    title: z.string().describe("New title for the task list"),
  },
  async ({ tasklist, title }) => {
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
      const response = await tasks.tasklists.update({
        tasklist,
        requestBody: {
          title,
        },
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
server.tool(
  "delete-tasklist",
  "Delete a task list",
  {
    tasklist: z.string().describe("Task list ID to delete"),
  },
  async ({ tasklist }) => {
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
      await tasks.tasklists.delete({
        tasklist,
      });

      return {
        content: [
          {
            type: "text",
            text: `Task list with ID '${tasklist}' was successfully deleted.`,
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
server.tool(
  "list-tasks",
  "List all tasks in a task list",
  {
    tasklist: z.string().describe("Task list ID"),
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
  },
  async ({
    tasklist,
    showCompleted = true,
    showHidden = false,
    showDeleted = false,
  }) => {
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
      const response: any = await tasks.tasks.list({
        tasklist,
        showCompleted,
        showHidden,
        showDeleted,
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

      const formattedTasks = tasksResponse.map((task: any) => ({
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
server.tool(
  "get-task",
  "Get a specific task by ID",
  {
    tasklist: z.string().describe("Task list ID"),
    task: z.string().describe("Task ID"),
  },
  async ({ tasklist, task }) => {
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
      const response = await tasks.tasks.get({
        tasklist,
        task,
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
server.tool(
  "create-task",
  "Create a new task in a task list",
  {
    tasklist: z.string().describe("Task list ID"),
    title: z.string().describe("Title of the task"),
    notes: z.string().optional().describe("Notes for the task"),
    due: z
      .string()
      .optional()
      .describe("Due date in RFC 3339 format (e.g., 2025-03-19T12:00:00Z)"),
  },
  async ({ tasklist, title, notes, due }) => {
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
      const requestBody: any = {
        title,
        status: "needsAction",
      };

      if (notes) requestBody.notes = notes;
      if (due) requestBody.due = due;

      const response = await tasks.tasks.insert({
        tasklist,
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
server.tool(
  "update-task",
  "Update an existing task",
  {
    tasklist: z.string().describe("Task list ID"),
    task: z.string().describe("Task ID"),
    title: z.string().optional().describe("New title for the task"),
    notes: z.string().optional().describe("New notes for the task"),
    status: z
      .enum(["needsAction", "completed"])
      .optional()
      .describe("Status of the task"),
    due: z
      .string()
      .optional()
      .describe("Due date in RFC 3339 format (e.g., 2025-03-19T12:00:00Z)"),
  },
  async ({ tasklist, task, title, notes, status, due }) => {
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
      // First, get the current task data
      const currentTask = await tasks.tasks.get({
        tasklist,
        task,
      });

      // Prepare the update request
      const requestBody: any = {
        ...currentTask.data,
      };

      if (title !== undefined) requestBody.title = title;
      if (notes !== undefined) requestBody.notes = notes;
      if (status !== undefined) requestBody.status = status;
      if (due !== undefined) requestBody.due = due;

      const response = await tasks.tasks.update({
        tasklist,
        task,
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
server.tool(
  "delete-task",
  "Delete a task",
  {
    tasklist: z.string().describe("Task list ID"),
    task: z.string().describe("Task ID to delete"),
  },
  async ({ tasklist, task }) => {
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
      await tasks.tasks.delete({
        tasklist,
        task,
      });

      return {
        content: [
          {
            type: "text",
            text: `Task with ID '${task}' was successfully deleted.`,
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
server.tool(
  "complete-task",
  "Mark a task as completed",
  {
    tasklist: z.string().describe("Task list ID"),
    task: z.string().describe("Task ID to mark as completed"),
  },
  async ({ tasklist, task }) => {
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
      // Get the current task
      const currentTask = await tasks.tasks.get({
        tasklist,
        task,
      });

      // Update the status to completed
      const requestBody = {
        ...currentTask.data,
        status: "completed",
        completed: new Date().toISOString(),
      };

      const response = await tasks.tasks.update({
        tasklist,
        task,
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
server.tool(
  "move-task",
  "Move a task to another position",
  {
    tasklist: z.string().describe("Task list ID"),
    task: z.string().describe("Task ID to move"),
    parent: z.string().optional().describe("Optional new parent task ID"),
    previous: z
      .string()
      .optional()
      .describe("Optional previous sibling task ID"),
  },
  async ({ tasklist, task, parent, previous }) => {
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
      const moveParams: any = {
        tasklist,
        task,
      };

      if (parent !== undefined) moveParams.parent = parent;
      if (previous !== undefined) moveParams.previous = previous;

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
server.tool(
  "clear-completed-tasks",
  "Clear all completed tasks from a task list",
  {
    tasklist: z.string().describe("Task list ID"),
  },
  async ({ tasklist }) => {
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
      await tasks.tasks.clear({
        tasklist,
      });

      return {
        content: [
          {
            type: "text",
            text: `All completed tasks in list '${tasklist}' have been cleared.`,
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

// Start the server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Google Tasks MCP Server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error in main():", error);
  process.exit(1);
});
