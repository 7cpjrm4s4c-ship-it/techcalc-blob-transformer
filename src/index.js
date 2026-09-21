const GitHubApiBaseUrl = "https://api.github.com";
const JsonContentType = "application/json; charset=utf-8";

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: {
      "content-type": JsonContentType,
      "cache-control": "no-store"
    }
  });
}

function errorResponse(message, status = 400, details = undefined) {
  return jsonResponse(
    {
      ok: false,
      service: "techcalc-blob-transformer",
      error: message,
      ...(details ? { details } : {})
    },
    status
  );
}

function createHttpError(status, message, details = undefined) {
  const error = new Error(message);
  error.status = status;
  error.details = details;
  return error;
}

function requireEnv(env, name) {
  const value = env[name];

  if (!value || typeof value !== "string") {
    throw createHttpError(500, `Missing required environment variable: ${name}`);
  }

  return value;
}

function validateClientAuthorization(request, env) {
  const expectedToken = env.TRANSFORM_API_TOKEN;

  if (!expectedToken) {
    return true;
  }

  const authorization = request.headers.get("authorization") || "";

  if (!authorization.startsWith("Bearer ")) {
    return false;
  }

  const receivedToken = authorization.slice("Bearer ".length).trim();
  return receivedToken.length > 0 && receivedToken === expectedToken;
}

function validateAllowedRepository(owner, repo, env) {
  const allowedRepository = env.ALLOWED_REPOSITORY;

  if (!allowedRepository) {
    return true;
  }

  return `${owner}/${repo}` === allowedRepository;
}

function parsePathRoute(pathname) {
  const match = pathname.match(
    /^\/repos\/([^/]+)\/([^/]+)\/git\/blobs\/([^/]+)\/(transform|patch)$/
  );

  if (!match) {
    return null;
  }

  return {
    owner: decodeURIComponent(match[1]),
    repo: decodeURIComponent(match[2]),
    fileSha: decodeURIComponent(match[3]),
    action: match[4]
  };
}

function parseBodyRoute(pathname, body) {
  const normalizedPath = pathname.endsWith("/") && pathname.length > 1
    ? pathname.slice(0, -1)
    : pathname;

  if (normalizedPath === "/transformBlob" || normalizedPath === "/transform-blob") {
    return createBodyRoute(body, "transform");
  }

  if (normalizedPath === "/patchBlob" || normalizedPath === "/patch-blob") {
    return createBodyRoute(body, "patch");
  }

  if (normalizedPath === "/" && Array.isArray(body?.operations)) {
    return createBodyRoute(body, "transform");
  }

  if (normalizedPath === "/" && typeof body?.patch === "string") {
    return createBodyRoute(body, "patch");
  }

  return null;
}

function createBodyRoute(body, action) {
  return {
    owner: body.owner,
    repo: body.repo,
    fileSha: body.file_sha || body.fileSha,
    action
  };
}

function validateRoute(route) {
  validateRequiredString(route.owner, "owner");
  validateRequiredString(route.repo, "repo");
  validateRequiredString(route.fileSha, "file_sha");

  if (!/^[a-f0-9]{40}$/i.test(route.fileSha)) {
    throw createHttpError(400, "file_sha must be a 40-character Git SHA.");
  }
}

function validateRequiredString(value, fieldName) {
  if (typeof value !== "string" || value.length === 0) {
    throw createHttpError(400, `${fieldName} is required.`);
  }
}

function decodeBase64Utf8(base64Content) {
  const binary = atob(base64Content.replace(/\s/g, ""));
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

function encodeUtf8Base64(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = "";

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary);
}

function byteSizeUtf8(text) {
  return new TextEncoder().encode(text).byteLength;
}

function normalizeOutputEncoding(value) {
  if (value === "base64") {
    return "base64";
  }

  return "utf-8";
}

async function githubFetch(path, env, options = {}) {
  const githubToken = requireEnv(env, "GITHUB_TOKEN");

  const response = await fetch(`${GitHubApiBaseUrl}${path}`, {
    ...options,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${githubToken}`,
      "user-agent": "techcalc-blob-transformer",
      "x-github-api-version": "2022-11-28",
      ...(options.headers || {})
    }
  });

  const text = await response.text();
  let payload = null;

  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { raw: text };
    }
  }

  if (!response.ok) {
    throw createHttpError(
      response.status,
      `GitHub API request failed: ${response.status} ${response.statusText}`,
      payload
    );
  }

  return payload;
}

async function getGitBlob(owner, repo, fileSha, env) {
  const encodedOwner = encodeURIComponent(owner);
  const encodedRepo = encodeURIComponent(repo);
  const encodedSha = encodeURIComponent(fileSha);

  const blob = await githubFetch(
    `/repos/${encodedOwner}/${encodedRepo}/git/blobs/${encodedSha}`,
    env
  );

  if (!blob || typeof blob.content !== "string") {
    throw createHttpError(502, "GitHub blob response did not contain content.");
  }

  if (blob.encoding !== "base64") {
    throw createHttpError(415, `Unsupported GitHub blob encoding: ${blob.encoding}`);
  }

  return {
    sha: blob.sha,
    size: blob.size,
    encoding: blob.encoding,
    text: decodeBase64Utf8(blob.content)
  };
}

async function createGitBlob(owner, repo, text, env, outputEncoding) {
  const encodedOwner = encodeURIComponent(owner);
  const encodedRepo = encodeURIComponent(repo);
  const encoding = normalizeOutputEncoding(outputEncoding);
  const content = encoding === "base64" ? encodeUtf8Base64(text) : text;

  return githubFetch(`/repos/${encodedOwner}/${encodedRepo}/git/blobs`, env, {
    method: "POST",
    headers: {
      "content-type": JsonContentType
    },
    body: JSON.stringify({
      content,
      encoding
    })
  });
}

function applyTextOperations(inputText, operations) {
  let outputText = inputText;

  const results = operations.map((operation) => {
    if (!operation || typeof operation !== "object") {
      throw createHttpError(400, "Each operation must be an object.");
    }

    const { type, search, replace } = operation;

    if (type !== "replace" && type !== "replaceRegex") {
      throw createHttpError(400, `Unsupported operation type: ${type}`);
    }

    if (typeof search !== "string") {
      throw createHttpError(400, "Operation search must be a string.");
    }

    if (typeof replace !== "string") {
      throw createHttpError(400, "Operation replace must be a string.");
    }

    if (type === "replace") {
      if (search.length === 0) {
        throw createHttpError(400, "replace search must not be empty.");
      }

      const matches = outputText.split(search).length - 1;
      const before = outputText;
      outputText = outputText.split(search).join(replace);

      return {
        type,
        matches,
        changed: before !== outputText
      };
    }

    const flags = typeof operation.flags === "string" ? operation.flags : "g";
    const safeFlags = flags.includes("g") ? flags : `${flags}g`;
    const regex = new RegExp(search, safeFlags);
    const matches = Array.from(outputText.matchAll(regex)).length;
    const before = outputText;
    outputText = outputText.replace(regex, replace);

    return {
      type,
      matches,
      changed: before !== outputText
    };
  });

  return {
    outputText,
    operations: results
  };
}

function parseUnifiedDiff(patch) {
  const lines = patch.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const hunks = [];
  let currentHunk = null;

  for (const line of lines) {
    const header = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);

    if (header) {
      currentHunk = {
        oldStart: Number(header[1]),
        newStart: Number(header[2]),
        lines: []
      };
      hunks.push(currentHunk);
      continue;
    }

    if (!currentHunk) {
      continue;
    }

    if (
      line.startsWith(" ") ||
      line.startsWith("-") ||
      line.startsWith("+") ||
      line.startsWith("\\")
    ) {
      currentHunk.lines.push(line);
    }
  }

  if (hunks.length === 0) {
    throw createHttpError(400, "Patch does not contain a unified diff hunk.");
  }

  return hunks;
}

function applyUnifiedDiff(inputText, patch) {
  const hasTrailingNewline = inputText.endsWith("\n");
  const sourceLines = inputText.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");

  if (hasTrailingNewline) {
    sourceLines.pop();
  }

  const hunks = parseUnifiedDiff(patch);
  const outputLines = [];
  let sourceIndex = 0;

  for (const hunk of hunks) {
    const hunkStartIndex = hunk.oldStart - 1;

    if (hunkStartIndex < sourceIndex) {
      throw createHttpError(409, "Patch hunks overlap or are out of order.");
    }

    while (sourceIndex < hunkStartIndex) {
      outputLines.push(sourceLines[sourceIndex]);
      sourceIndex += 1;
    }

    for (const diffLine of hunk.lines) {
      if (diffLine.startsWith("\\")) {
        continue;
      }

      const marker = diffLine[0];
      const content = diffLine.slice(1);

      if (marker === " ") {
        if (sourceLines[sourceIndex] !== content) {
          throw createHttpError(
            409,
            `Patch context mismatch at source line ${sourceIndex + 1}.`
          );
        }

        outputLines.push(content);
        sourceIndex += 1;
        continue;
      }

      if (marker === "-") {
        if (sourceLines[sourceIndex] !== content) {
          throw createHttpError(
            409,
            `Patch removal mismatch at source line ${sourceIndex + 1}.`
          );
        }

        sourceIndex += 1;
        continue;
      }

      if (marker === "+") {
        outputLines.push(content);
      }
    }
  }

  while (sourceIndex < sourceLines.length) {
    outputLines.push(sourceLines[sourceIndex]);
    sourceIndex += 1;
  }

  const outputText = outputLines.join("\n");
  return hasTrailingNewline ? `${outputText}\n` : outputText;
}

function validateSafetyChecks(blob, body) {
  if (body.expected_sha && body.expected_sha !== blob.sha) {
    throw createHttpError(
      409,
      `expected_sha mismatch: expected ${body.expected_sha}, got ${blob.sha}`
    );
  }

  if (
    typeof body.expected_size === "number" &&
    Number.isFinite(body.expected_size) &&
    body.expected_size !== blob.size
  ) {
    throw createHttpError(
      409,
      `expected_size mismatch: expected ${body.expected_size}, got ${blob.size}`
    );
  }
}

function createBaseOperationResponse(blob, outputText, dryRun, operation) {
  return {
    ok: true,
    service: "techcalc-blob-transformer",
    operation,
    dry_run: dryRun,
    input_sha: blob.sha,
    input_size: blob.size,
    output_size: byteSizeUtf8(outputText)
  };
}

async function handleTransform(request, env, route, body) {
  if (!Array.isArray(body.operations) || body.operations.length === 0) {
    return errorResponse("Request body requires non-empty operations array.", 400);
  }

  const blob = await getGitBlob(route.owner, route.repo, route.fileSha, env);
  validateSafetyChecks(blob, body);

  const transformed = applyTextOperations(blob.text, body.operations);
  const dryRun = body.dry_run === true;
  const matches = transformed.operations.reduce((sum, operation) => {
    return sum + operation.matches;
  }, 0);
  const response = {
    ...createBaseOperationResponse(blob, transformed.outputText, dryRun, "transformBlob"),
    changed: blob.text !== transformed.outputText,
    matches,
    operation_count: transformed.operations.length,
    operations: transformed.operations
  };

  if (dryRun) {
    return jsonResponse(response);
  }

  const createdBlob = await createGitBlob(
    route.owner,
    route.repo,
    transformed.outputText,
    env,
    body.output_encoding
  );

  return jsonResponse(
    {
      ...response,
      output_sha: createdBlob.sha,
      output_encoding: normalizeOutputEncoding(body.output_encoding)
    },
    201
  );
}

async function handlePatch(request, env, route, body) {
  if (typeof body.patch !== "string" || body.patch.length === 0) {
    return errorResponse("Request body requires patch string.", 400);
  }

  const blob = await getGitBlob(route.owner, route.repo, route.fileSha, env);
  validateSafetyChecks(blob, body);

  const outputText = applyUnifiedDiff(blob.text, body.patch);
  const dryRun = body.dry_run === true;
  const response = {
    ...createBaseOperationResponse(blob, outputText, dryRun, "patchBlob"),
    changed: blob.text !== outputText
  };

  if (dryRun) {
    return jsonResponse(response);
  }

  const createdBlob = await createGitBlob(
    route.owner,
    route.repo,
    outputText,
    env,
    body.output_encoding
  );

  return jsonResponse(
    {
      ...response,
      output_sha: createdBlob.sha,
      output_encoding: normalizeOutputEncoding(body.output_encoding)
    },
    201
  );
}

async function readJsonBody(request) {
  try {
    return await request.json();
  } catch {
    throw createHttpError(400, "Request body must be valid JSON.");
  }
}

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);

      if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
        return jsonResponse({
          ok: true,
          service: "techcalc-blob-transformer"
        });
      }

      if (request.method !== "POST") {
        return errorResponse("Method not allowed.", 405);
      }

      const body = await readJsonBody(request);
      const pathRoute = parsePathRoute(url.pathname);
      const route = pathRoute || parseBodyRoute(url.pathname, body);

      if (!route) {
        return errorResponse("Not found.", 404);
      }

      validateRoute(route);

      if (!validateClientAuthorization(request, env)) {
        return errorResponse("Unauthorized.", 401);
      }

      if (!validateAllowedRepository(route.owner, route.repo, env)) {
        return errorResponse("Repository is not allowed.", 403, {
          repository: `${route.owner}/${route.repo}`
        });
      }

      if (route.action === "transform") {
        return await handleTransform(request, env, route, body);
      }

      if (route.action === "patch") {
        return await handlePatch(request, env, route, body);
      }

      return errorResponse("Unsupported action.", 404);
    } catch (error) {
      const status = error && typeof error.status === "number" ? error.status : 500;
      const details = error && "details" in error ? error.details : undefined;

      return errorResponse(
        error instanceof Error ? error.message : "Unexpected worker error.",
        status,
        details
      );
    }
  }
};
