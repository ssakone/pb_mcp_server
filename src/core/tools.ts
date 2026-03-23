import { FastMCP } from "fastmcp";
import { z } from "zod";
import PocketBase from "pocketbase";
import {
  createClient,
  getPocketBaseUrl,
  authenticateAdmin,
  authenticateUser,
  logout,
  getAuthStatus,
  isAuthenticated,
  listCollections,
  getCollection,
  createCollection,
  updateCollection,
  deleteCollection,
  listRecords,
  getRecord,
  createRecord,
  updateRecord,
  deleteRecord,
  listUsers,
  getUser,
  createUser,
  updateUser,
  deleteUser,
} from "./services/pocketbase/index.js";
import { handleError } from "./services/pocketbase/error-handler.js";
import { formatOutput } from "./services/output-formatter.js";

/**
 * Store for maintaining authentication state across tool calls.
 * Each baseUrl gets its own PocketBase client instance.
 */
const clientStore: Map<string, PocketBase> = new Map();

/**
 * Resolve admin credentials from environment variables.
 */
function getEnvAdminCredentials(): {
  email: string;
  password: string;
  baseUrl?: string;
} | null {
  const email = process.env.POCKETBASE_ADMIN_EMAIL;
  const password = process.env.POCKETBASE_ADMIN_PASSWORD;
  const baseUrl = process.env.POCKETBASE_URL;

  if (!email || !password) {
    return null;
  }

  return { email, password, baseUrl };
}

/**
 * Create a reusable authenticated client from a token.
 */
function createAuthenticatedClient(url: string, token: string): PocketBase {
  const pb = new PocketBase(url);
  pb.authStore.save(token, null);
  return pb;
}

/**
 * Authenticate once using env credentials and cache the resulting client.
 */
async function ensureAdminSession(baseUrl?: string): Promise<PocketBase> {
  const url = getPocketBaseUrl(baseUrl);
  const cached = clientStore.get(url);

  if (cached && cached.authStore.isValid) {
    return cached;
  }

  const envCredentials = getEnvAdminCredentials();

  if (envCredentials) {
    try {
      const authResult = await authenticateAdmin(
        {
          email: envCredentials.email,
          password: envCredentials.password,
        },
        envCredentials.baseUrl ?? url,
      );

      process.env.POCKETBASE_ADMIN_TOKEN = authResult.token;

      const authenticatedClient = createAuthenticatedClient(
        url,
        authResult.token,
      );
      clientStore.set(url, authenticatedClient);
      return authenticatedClient;
    } catch (error) {
      const errorResponse = handleError(error);
      throw new Error(
        typeof errorResponse === "string"
          ? errorResponse
          : (errorResponse as any)?.message ||
              "PocketBase admin authentication failed",
      );
    }
  }

  const token = process.env.POCKETBASE_ADMIN_TOKEN;
  if (token) {
    const tokenClient = createAuthenticatedClient(url, token);
    clientStore.set(url, tokenClient);
    return tokenClient;
  }

  throw new Error(
    "PocketBase admin token is required. Provide it as parameter, authenticate first, or set POCKETBASE_ADMIN_TOKEN / POCKETBASE_ADMIN_EMAIL / POCKETBASE_ADMIN_PASSWORD environment variables.",
  );
}

/**
 * Utility function to get PocketBase client with admin token.
 * Priority:
 * 1. Explicit adminToken parameter
 * 2. Cached authenticated client
 * 3. Auto-login using env credentials
 * 4. POCKETBASE_ADMIN_TOKEN environment variable
 */
async function getPocketBaseClient(
  adminToken?: string,
  baseUrl?: string,
): Promise<PocketBase> {
  const url = getPocketBaseUrl(baseUrl);

  console.error(
    `[getPocketBaseClient] URL: ${url}, adminToken provided: ${!!adminToken}, cached: ${clientStore.has(url)}`,
  );

  if (adminToken) {
    console.error("[getPocketBaseClient] Using explicit adminToken");
    const pb = createAuthenticatedClient(url, adminToken);
    clientStore.set(url, pb);
    return pb;
  }

  const cachedClient = clientStore.get(url);
  if (cachedClient?.authStore.isValid) {
    console.error("[getPocketBaseClient] Using cached authenticated client");
    return cachedClient;
  }

  const envCredentials = getEnvAdminCredentials();
  if (envCredentials) {
    console.error(
      `[getPocketBaseClient] Attempting auto-login with env credentials for ${envCredentials.email}`,
    );
    return ensureAdminSession(baseUrl);
  }

  const token = process.env.POCKETBASE_ADMIN_TOKEN;
  if (token) {
    console.error("[getPocketBaseClient] Using env token");
    const pb = createAuthenticatedClient(url, token);
    clientStore.set(url, pb);
    return pb;
  }

  throw new Error(
    "PocketBase admin token is required. Provide it as parameter, authenticate first, or set POCKETBASE_ADMIN_TOKEN environment variable.",
  );
}

/**
 * Get or create a PocketBase client for the given baseUrl.
 * This allows maintaining authentication state across multiple tool calls.
 */
function getOrCreateClient(baseUrl?: string): PocketBase {
  const url = getPocketBaseUrl(baseUrl);

  if (!clientStore.has(url)) {
    const token = process.env.POCKETBASE_ADMIN_TOKEN;
    if (token) {
      clientStore.set(url, createAuthenticatedClient(url, token));
    } else {
      clientStore.set(url, createClient({ baseUrl: url }));
    }
  } else {
    const existingClient = clientStore.get(url)!;
    const token = process.env.POCKETBASE_ADMIN_TOKEN;

    if (!existingClient.authStore.isValid && token) {
      existingClient.authStore.save(token, null);
    }
  }

  return clientStore.get(url)!;
}

/**
 * Register all tools with the MCP server
 *
 * @param server The FastMCP server instance
 */
export function registerTools(server: FastMCP) {
  // ============================================
  // Collection Management Tools
  // Requirements: 2.1, 2.2, 2.3, 3.1, 3.2, 3.3, 3.4
  // ============================================

  // PocketBase: Get collections list
  server.addTool({
    name: "list_collections",
    description:
      "Get the list of all collections from PocketBase. Returns collection names, types, and basic metadata including created/updated timestamps.",
    parameters: z.object({
      adminToken: z
        .string()
        .optional()
        .describe(
          "PocketBase admin token (or use POCKETBASE_ADMIN_TOKEN env var)",
        ),
      baseUrl: z
        .string()
        .optional()
        .describe(
          "PocketBase base URL (or use POCKETBASE_URL env var, default: http://127.0.0.1:8090)",
        ),
    }),
    execute: async (params) => {
      try {
        const pb = await getPocketBaseClient(params.adminToken, params.baseUrl);
        const result = await listCollections(pb);
        return formatOutput(result);
      } catch (error) {
        const errorResponse = handleError(error);
        return formatOutput(errorResponse);
      }
    },
  });

  // PocketBase: Get specific collection details
  server.addTool({
    name: "get_collection",
    description:
      "Get detailed information about a specific collection from PocketBase. Returns complete schema including field definitions, types, constraints, and access rules (listRule, viewRule, createRule, updateRule, deleteRule).",
    parameters: z.object({
      collectionName: z
        .string()
        .describe("Name or ID of the collection to retrieve"),
      adminToken: z
        .string()
        .optional()
        .describe(
          "PocketBase admin token (or use POCKETBASE_ADMIN_TOKEN env var)",
        ),
      baseUrl: z
        .string()
        .optional()
        .describe(
          "PocketBase base URL (or use POCKETBASE_URL env var, default: http://127.0.0.1:8090)",
        ),
    }),
    execute: async (params) => {
      try {
        const pb = await getPocketBaseClient(params.adminToken, params.baseUrl);
        const result = await getCollection(pb, params.collectionName);
        return formatOutput(result);
      } catch (error) {
        const errorResponse = handleError(error);
        return formatOutput(errorResponse);
      }
    },
  });

  // PocketBase: Create collection
  server.addTool({
    name: "create_collection",
    description:
      "Create a new collection in PocketBase. Requires admin authentication. Validates schema structure before creation.",
    parameters: z.object({
      name: z
        .string()
        .min(3)
        .max(100)
        .describe(
          "Collection name (must start with a letter, contain only letters, numbers, and underscores)",
        ),
      type: z
        .enum(["base", "auth", "view"])
        .describe(
          "Collection type: 'base' for regular data, 'auth' for user authentication, 'view' for SQL views",
        ),
      schema: z
        .array(
          z.object({
            name: z.string().describe("Field name"),
            type: z
              .string()
              .describe(
                "Field type: text, number, bool, email, url, date, select, file, relation, json, editor, autodate",
              ),
            required: z.boolean().describe("Whether the field is required"),
            options: z
              .record(z.any())
              .optional()
              .describe("Field-specific options"),
          }),
        )
        .describe("Array of schema field definitions"),
      listRule: z
        .string()
        .nullable()
        .optional()
        .describe("Rule for listing records (null = admin only, '' = public)"),
      viewRule: z
        .string()
        .nullable()
        .optional()
        .describe("Rule for viewing records"),
      createRule: z
        .string()
        .nullable()
        .optional()
        .describe("Rule for creating records"),
      updateRule: z
        .string()
        .nullable()
        .optional()
        .describe("Rule for updating records"),
      deleteRule: z
        .string()
        .nullable()
        .optional()
        .describe("Rule for deleting records"),
      options: z
        .record(z.any())
        .optional()
        .describe("Additional collection options"),
      adminToken: z
        .string()
        .optional()
        .describe(
          "PocketBase admin token (or use POCKETBASE_ADMIN_TOKEN env var)",
        ),
      baseUrl: z
        .string()
        .optional()
        .describe(
          "PocketBase base URL (or use POCKETBASE_URL env var, default: http://127.0.0.1:8090)",
        ),
    }),
    execute: async (params) => {
      try {
        const pb = await getPocketBaseClient(params.adminToken, params.baseUrl);
        const result = await createCollection(pb, {
          name: params.name,
          type: params.type,
          schema: params.schema,
          listRule: params.listRule,
          viewRule: params.viewRule,
          createRule: params.createRule,
          updateRule: params.updateRule,
          deleteRule: params.deleteRule,
          options: params.options,
        });
        return formatOutput(result);
      } catch (error) {
        const errorResponse = handleError(error);
        return formatOutput(errorResponse);
      }
    },
  });

  // PocketBase: Update collection
  server.addTool({
    name: "update_collection",
    description:
      "Update an existing collection in PocketBase. Requires admin authentication. Only provided fields will be updated.",
    parameters: z.object({
      collectionName: z
        .string()
        .describe("Name or ID of the collection to update"),
      name: z
        .string()
        .min(3)
        .max(100)
        .optional()
        .describe("New collection name"),
      type: z
        .enum(["base", "auth", "view"])
        .optional()
        .describe("New collection type"),
      schema: z
        .array(
          z.object({
            name: z.string().describe("Field name"),
            type: z.string().describe("Field type"),
            required: z.boolean().describe("Whether the field is required"),
            options: z
              .record(z.any())
              .optional()
              .describe("Field-specific options"),
          }),
        )
        .optional()
        .describe("New schema field definitions (replaces existing schema)"),
      listRule: z
        .string()
        .nullable()
        .optional()
        .describe("Rule for listing records"),
      viewRule: z
        .string()
        .nullable()
        .optional()
        .describe("Rule for viewing records"),
      createRule: z
        .string()
        .nullable()
        .optional()
        .describe("Rule for creating records"),
      updateRule: z
        .string()
        .nullable()
        .optional()
        .describe("Rule for updating records"),
      deleteRule: z
        .string()
        .nullable()
        .optional()
        .describe("Rule for deleting records"),
      options: z
        .record(z.any())
        .optional()
        .describe("Additional collection options"),
      adminToken: z
        .string()
        .optional()
        .describe(
          "PocketBase admin token (or use POCKETBASE_ADMIN_TOKEN env var)",
        ),
      baseUrl: z
        .string()
        .optional()
        .describe(
          "PocketBase base URL (or use POCKETBASE_URL env var, default: http://127.0.0.1:8090)",
        ),
    }),
    execute: async (params) => {
      try {
        const pb = await getPocketBaseClient(params.adminToken, params.baseUrl);
        const updateData: any = {};

        if (params.name !== undefined) updateData.name = params.name;
        if (params.type !== undefined) updateData.type = params.type;
        if (params.schema !== undefined) {
          updateData.schema = params.schema as Array<{
            name: string;
            type: string;
            required: boolean;
            options?: Record<string, any>;
          }>;
        }
        if (params.listRule !== undefined)
          updateData.listRule = params.listRule;
        if (params.viewRule !== undefined)
          updateData.viewRule = params.viewRule;
        if (params.createRule !== undefined)
          updateData.createRule = params.createRule;
        if (params.updateRule !== undefined)
          updateData.updateRule = params.updateRule;
        if (params.deleteRule !== undefined)
          updateData.deleteRule = params.deleteRule;
        if (params.options !== undefined) updateData.options = params.options;

        const result = await updateCollection(
          pb,
          params.collectionName,
          updateData,
        );
        return formatOutput(result);
      } catch (error) {
        const errorResponse = handleError(error);
        return formatOutput(errorResponse);
      }
    },
  });

  // PocketBase: Delete collection
  server.addTool({
    name: "delete_collection",
    description:
      "Delete an existing collection from PocketBase. This action is irreversible and will permanently remove the collection and all its records.",
    parameters: z.object({
      collectionName: z
        .string()
        .describe("Name or ID of the collection to delete"),
      adminToken: z
        .string()
        .optional()
        .describe(
          "PocketBase admin token (or use POCKETBASE_ADMIN_TOKEN env var)",
        ),
      baseUrl: z
        .string()
        .optional()
        .describe(
          "PocketBase base URL (or use POCKETBASE_URL env var, default: http://127.0.0.1:8090)",
        ),
    }),
    execute: async (params) => {
      try {
        const pb = await getPocketBaseClient(params.adminToken, params.baseUrl);
        const result = await deleteCollection(pb, params.collectionName);
        return formatOutput(result);
      } catch (error) {
        const errorResponse = handleError(error);
        return formatOutput(errorResponse);
      }
    },
  });

  // PocketBase: List records
  server.addTool({
    name: "list_records",
    description:
      "List records from a PocketBase collection with optional filtering, sorting, and pagination. Returns records with pagination metadata.",
    parameters: z.object({
      collection: z.string().describe("Collection name or ID to query"),
      filter: z
        .string()
        .optional()
        .describe(
          "Filter expression using PocketBase filter syntax (e.g., \"status='active' && created>'2023-01-01'\")",
        ),
      sort: z
        .string()
        .optional()
        .describe(
          "Sort expression (e.g., '-created,title' for descending created, ascending title)",
        ),
      page: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Page number (default: 1)"),
      perPage: z
        .number()
        .int()
        .positive()
        .max(500)
        .optional()
        .describe("Records per page (default: 30, max: 500)"),
      expand: z
        .string()
        .optional()
        .describe("Relations to expand (e.g., 'author,comments')"),
      fields: z
        .string()
        .optional()
        .describe("Fields to return (e.g., 'id,title,created')"),
      adminToken: z
        .string()
        .optional()
        .describe(
          "PocketBase admin token (or use POCKETBASE_ADMIN_TOKEN env var)",
        ),
      baseUrl: z
        .string()
        .optional()
        .describe(
          "PocketBase base URL (or use POCKETBASE_URL env var, default: http://127.0.0.1:8090)",
        ),
    }),
    execute: async (params) => {
      try {
        const pb = await getPocketBaseClient(params.adminToken, params.baseUrl);
        const result = await listRecords(pb, params.collection, {
          filter: params.filter,
          sort: params.sort,
          page: params.page,
          perPage: params.perPage,
          expand: params.expand,
          fields: params.fields,
        });
        return formatOutput(result);
      } catch (error) {
        const errorResponse = handleError(error);
        return formatOutput(errorResponse);
      }
    },
  });

  // PocketBase: Get record
  server.addTool({
    name: "get_record",
    description:
      "Get a single record by ID from a PocketBase collection. Returns the full record with all fields.",
    parameters: z.object({
      collection: z.string().describe("Collection name or ID"),
      id: z.string().describe("Record ID to retrieve"),
      expand: z
        .string()
        .optional()
        .describe("Relations to expand (e.g., 'author,comments')"),
      fields: z
        .string()
        .optional()
        .describe("Fields to return (e.g., 'id,title,created')"),
      adminToken: z
        .string()
        .optional()
        .describe(
          "PocketBase admin token (or use POCKETBASE_ADMIN_TOKEN env var)",
        ),
      baseUrl: z
        .string()
        .optional()
        .describe(
          "PocketBase base URL (or use POCKETBASE_URL env var, default: http://127.0.0.1:8090)",
        ),
    }),
    execute: async (params) => {
      try {
        const pb = await getPocketBaseClient(params.adminToken, params.baseUrl);
        const result = await getRecord(pb, params.collection, params.id, {
          expand: params.expand,
          fields: params.fields,
        });
        return formatOutput(result);
      } catch (error) {
        const errorResponse = handleError(error);
        return formatOutput(errorResponse);
      }
    },
  });

  // PocketBase: Create record
  server.addTool({
    name: "create_record",
    description:
      "Create a new record in a PocketBase collection. Requires admin authentication.",
    parameters: z.object({
      collection: z.string().describe("Collection name or ID"),
      data: z.record(z.any()).describe("Record data to create"),
      adminToken: z
        .string()
        .optional()
        .describe(
          "PocketBase admin token (or use POCKETBASE_ADMIN_TOKEN env var)",
        ),
      baseUrl: z
        .string()
        .optional()
        .describe(
          "PocketBase base URL (or use POCKETBASE_URL env var, default: http://127.0.0.1:8090)",
        ),
    }),
    execute: async (params) => {
      try {
        const pb = await getPocketBaseClient(params.adminToken, params.baseUrl);
        const result = await createRecord(pb, params.collection, params.data);
        return formatOutput(result);
      } catch (error) {
        const errorResponse = handleError(error);
        return formatOutput(errorResponse);
      }
    },
  });

  // PocketBase: Update record
  server.addTool({
    name: "update_record",
    description:
      "Update an existing record in a PocketBase collection. Only provided fields will be updated.",
    parameters: z.object({
      collection: z.string().describe("Collection name or ID"),
      id: z.string().describe("Record ID to update"),
      data: z.record(z.any()).describe("Fields to update"),
      adminToken: z
        .string()
        .optional()
        .describe(
          "PocketBase admin token (or use POCKETBASE_ADMIN_TOKEN env var)",
        ),
      baseUrl: z
        .string()
        .optional()
        .describe(
          "PocketBase base URL (or use POCKETBASE_URL env var, default: http://127.0.0.1:8090)",
        ),
    }),
    execute: async (params) => {
      try {
        const pb = await getPocketBaseClient(params.adminToken, params.baseUrl);
        const result = await updateRecord(
          pb,
          params.collection,
          params.id,
          params.data,
        );
        return formatOutput(result);
      } catch (error) {
        const errorResponse = handleError(error);
        return formatOutput(errorResponse);
      }
    },
  });

  // PocketBase: Delete record
  server.addTool({
    name: "delete_record",
    description:
      "Delete a record from a PocketBase collection. This action is irreversible.",
    parameters: z.object({
      collection: z.string().describe("Collection name or ID"),
      id: z.string().describe("Record ID to delete"),
      adminToken: z
        .string()
        .optional()
        .describe(
          "PocketBase admin token (or use POCKETBASE_ADMIN_TOKEN env var)",
        ),
      baseUrl: z
        .string()
        .optional()
        .describe(
          "PocketBase base URL (or use POCKETBASE_URL env var, default: http://127.0.0.1:8090)",
        ),
    }),
    execute: async (params) => {
      try {
        const pb = await getPocketBaseClient(params.adminToken, params.baseUrl);
        const result = await deleteRecord(pb, params.collection, params.id);
        return formatOutput(result);
      } catch (error) {
        const errorResponse = handleError(error);
        return formatOutput(errorResponse);
      }
    },
  });

  // ============================================
  // User Management Tools
  // Requirements: 4.1, 4.2, 4.3, 4.4, 4.5
  // ============================================

  // PocketBase: List users
  server.addTool({
    name: "list_users",
    description:
      "List users from a PocketBase auth collection. Requires admin authentication.",
    parameters: z.object({
      collection: z
        .string()
        .optional()
        .default("users")
        .describe("Auth collection name"),
      filter: z
        .string()
        .optional()
        .describe("Filter expression using PocketBase filter syntax"),
      sort: z.string().optional().describe("Sort expression"),
      page: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Page number (default: 1)"),
      perPage: z
        .number()
        .int()
        .positive()
        .max(500)
        .optional()
        .describe("Users per page (default: 30, max: 500)"),
      expand: z.string().optional().describe("Relations to expand"),
      fields: z
        .string()
        .optional()
        .describe("Fields to return (e.g., 'id,email,verified')"),
      adminToken: z
        .string()
        .optional()
        .describe(
          "PocketBase admin token (or use POCKETBASE_ADMIN_TOKEN env var)",
        ),
      baseUrl: z
        .string()
        .optional()
        .describe(
          "PocketBase base URL (or use POCKETBASE_URL env var, default: http://127.0.0.1:8090)",
        ),
    }),
    execute: async (params) => {
      try {
        const pb = await getPocketBaseClient(params.adminToken, params.baseUrl);
        const result = await listUsers(pb, params.collection, {
          filter: params.filter,
          sort: params.sort,
          page: params.page,
          perPage: params.perPage,
          expand: params.expand,
          fields: params.fields,
        });
        return formatOutput(result);
      } catch (error) {
        const errorResponse = handleError(error);
        return formatOutput(errorResponse);
      }
    },
  });

  // PocketBase: Get user
  server.addTool({
    name: "get_user",
    description:
      "Get a single user by ID from a PocketBase auth collection. Returns the full user record.",
    parameters: z.object({
      collection: z
        .string()
        .optional()
        .default("users")
        .describe("Auth collection name"),
      id: z.string().describe("User ID to retrieve"),
      expand: z.string().optional().describe("Relations to expand"),
      fields: z
        .string()
        .optional()
        .describe("Fields to return (e.g., 'id,email,verified')"),
      adminToken: z
        .string()
        .optional()
        .describe(
          "PocketBase admin token (or use POCKETBASE_ADMIN_TOKEN env var)",
        ),
      baseUrl: z
        .string()
        .optional()
        .describe(
          "PocketBase base URL (or use POCKETBASE_URL env var, default: http://127.0.0.1:8090)",
        ),
    }),
    execute: async (params) => {
      try {
        const pb = await getPocketBaseClient(params.adminToken, params.baseUrl);
        const result = await getUser(pb, params.collection, params.id, {
          expand: params.expand,
          fields: params.fields,
        });
        return formatOutput(result);
      } catch (error) {
        const errorResponse = handleError(error);
        return formatOutput(errorResponse);
      }
    },
  });

  // PocketBase: Create user
  server.addTool({
    name: "create_user",
    description:
      "Create a new user in a PocketBase auth collection. Requires admin authentication.",
    parameters: z.object({
      collection: z
        .string()
        .optional()
        .default("users")
        .describe("Auth collection name"),
      email: z.string().email().describe("User email address"),
      password: z
        .string()
        .min(8)
        .describe("User password (minimum 8 characters)"),
      passwordConfirm: z
        .string()
        .min(8)
        .describe("Password confirmation (must match password)"),
      emailVisibility: z
        .boolean()
        .optional()
        .default(false)
        .describe("Whether email is visible to other users"),
      verified: z
        .boolean()
        .optional()
        .default(false)
        .describe("Whether user is verified"),
      name: z.string().optional().describe("User display name"),
      adminToken: z
        .string()
        .optional()
        .describe(
          "PocketBase admin token (or use POCKETBASE_ADMIN_TOKEN env var)",
        ),
      baseUrl: z
        .string()
        .optional()
        .describe(
          "PocketBase base URL (or use POCKETBASE_URL env var, default: http://127.0.0.1:8090)",
        ),
    }),
    execute: async (params) => {
      try {
        const pb = await getPocketBaseClient(params.adminToken, params.baseUrl);
        const result = await createUser(pb, params.collection, {
          email: params.email,
          password: params.password,
          passwordConfirm: params.passwordConfirm,
          emailVisibility: params.emailVisibility,
          verified: params.verified,
          name: params.name,
        });
        return formatOutput(result);
      } catch (error) {
        const errorResponse = handleError(error);
        return formatOutput(errorResponse);
      }
    },
  });

  // PocketBase: Update user
  server.addTool({
    name: "update_user",
    description:
      "Update an existing user in a PocketBase auth collection. Requires admin authentication.",
    parameters: z.object({
      collection: z
        .string()
        .optional()
        .default("users")
        .describe("Auth collection name"),
      id: z.string().describe("User ID to update"),
      email: z.string().email().optional().describe("New email address"),
      password: z
        .string()
        .min(8)
        .optional()
        .describe("New password (minimum 8 characters)"),
      passwordConfirm: z
        .string()
        .min(8)
        .optional()
        .describe("Password confirmation (required if password is set)"),
      oldPassword: z
        .string()
        .optional()
        .describe("Current password (required for non-admin password changes)"),
      emailVisibility: z
        .boolean()
        .optional()
        .describe("Whether email is visible to other users"),
      verified: z.boolean().optional().describe("Whether user is verified"),
      name: z.string().optional().describe("User display name"),
      adminToken: z
        .string()
        .optional()
        .describe(
          "PocketBase admin token (or use POCKETBASE_ADMIN_TOKEN env var)",
        ),
      baseUrl: z
        .string()
        .optional()
        .describe(
          "PocketBase base URL (or use POCKETBASE_URL env var, default: http://127.0.0.1:8090)",
        ),
    }),
    execute: async (params) => {
      try {
        const pb = await getPocketBaseClient(params.adminToken, params.baseUrl);
        const result = await updateUser(pb, params.collection, params.id, {
          email: params.email,
          password: params.password,
          passwordConfirm: params.passwordConfirm,
          oldPassword: params.oldPassword,
          emailVisibility: params.emailVisibility,
          verified: params.verified,
          name: params.name,
        });
        return formatOutput(result);
      } catch (error) {
        const errorResponse = handleError(error);
        return formatOutput(errorResponse);
      }
    },
  });

  // PocketBase: Delete user
  server.addTool({
    name: "delete_user",
    description:
      "Delete a user from a PocketBase auth collection. This action is irreversible.",
    parameters: z.object({
      collection: z
        .string()
        .optional()
        .default("users")
        .describe("Auth collection name"),
      id: z.string().describe("User ID to delete"),
      adminToken: z
        .string()
        .optional()
        .describe(
          "PocketBase admin token (or use POCKETBASE_ADMIN_TOKEN env var)",
        ),
      baseUrl: z
        .string()
        .optional()
        .describe(
          "PocketBase base URL (or use POCKETBASE_URL env var, default: http://127.0.0.1:8090)",
        ),
    }),
    execute: async (params) => {
      try {
        const pb = await getPocketBaseClient(params.adminToken, params.baseUrl);
        const result = await deleteUser(pb, params.collection, params.id);
        return formatOutput(result);
      } catch (error) {
        const errorResponse = handleError(error);
        return formatOutput(errorResponse);
      }
    },
  });

  // ============================================
  // Auth Management Tools
  // Requirements: 6.1, 6.2, 6.3, 6.5
  // ============================================

  // PocketBase: Authenticate admin
  server.addTool({
    name: "authenticate_admin",
    description:
      "Authenticate as admin with email and password. Stores the token for subsequent requests.",
    parameters: z.object({
      email: z.string().email().describe("Admin email address"),
      password: z.string().min(1).describe("Admin password"),
      baseUrl: z
        .string()
        .optional()
        .describe(
          "PocketBase base URL (or use POCKETBASE_URL env var, default: http://127.0.0.1:8090)",
        ),
    }),
    execute: async (params) => {
      try {
        const result = await authenticateAdmin(params, params.baseUrl);
        if (result.success) {
          const pb = await getPocketBaseClient(result.token, params.baseUrl);
          clientStore.set(getPocketBaseUrl(params.baseUrl), pb);
        }
        return formatOutput(result);
      } catch (error) {
        const errorResponse = handleError(error);
        return formatOutput(errorResponse);
      }
    },
  });

  // PocketBase: Authenticate user
  server.addTool({
    name: "authenticate_user",
    description:
      "Authenticate as user with email and password. Stores the token for subsequent requests.",
    parameters: z.object({
      email: z.string().email().describe("User email address"),
      password: z.string().min(1).describe("User password"),
      collection: z
        .string()
        .optional()
        .default("users")
        .describe("Auth collection name"),
      baseUrl: z
        .string()
        .optional()
        .describe(
          "PocketBase base URL (or use POCKETBASE_URL env var, default: http://127.0.0.1:8090)",
        ),
    }),
    execute: async (params) => {
      try {
        const result = await authenticateUser(
          params,
          params.collection,
          params.baseUrl,
        );
        if (result.success) {
          const pb = await getPocketBaseClient(result.token, params.baseUrl);
          clientStore.set(getPocketBaseUrl(params.baseUrl), pb);
        }
        return formatOutput(result);
      } catch (error) {
        const errorResponse = handleError(error);
        return formatOutput(errorResponse);
      }
    },
  });

  // PocketBase: Logout
  server.addTool({
    name: "logout",
    description: "Logout from PocketBase and clear the authentication session.",
    parameters: z.object({
      baseUrl: z
        .string()
        .optional()
        .describe(
          "PocketBase base URL (or use POCKETBASE_URL env var, default: http://127.0.0.1:8090)",
        ),
    }),
    execute: async (params) => {
      try {
        const pb = getOrCreateClient(params.baseUrl);
        logout(pb);
        clientStore.delete(getPocketBaseUrl(params.baseUrl));
        return formatOutput({
          success: true,
          message: "Logged out successfully",
        });
      } catch (error) {
        const errorResponse = handleError(error);
        return formatOutput(errorResponse);
      }
    },
  });

  // PocketBase: Authentication status
  server.addTool({
    name: "get_auth_status",
    description:
      "Check current authentication status and get current user info.",
    parameters: z.object({
      baseUrl: z
        .string()
        .optional()
        .describe(
          "PocketBase base URL (or use POCKETBASE_URL env var, default: http://127.0.0.1:8090)",
        ),
    }),
    execute: async (params) => {
      try {
        const pb = await getPocketBaseClient(undefined, params.baseUrl);
        const status = getAuthStatus(pb);
        return formatOutput(status);
      } catch (error) {
        const errorResponse = handleError(error);
        return formatOutput(errorResponse);
      }
    },
  });
}
