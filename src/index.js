const GITHUB_API_BASE = "https://api.github.com";

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}

function errorResponse(message, status = 400, details = undefined) {
  return jsonResponse(
    {
      error: message,
      ...(details ? { details } : {})
    },
    status
  );
}

function requireEnv(env, name) {
  const value = env[name];
  if (!value || typeof value !== "string") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function validateClientAuthorization(request, env) {
  const expectedToken = requireEnv(env, "TRANSFORM_API_TOKEN");
  const authorization = request.headers.get("authorization") || "";

  if (!authorization.startsWith("Bearer ")) {
    return false;
  }

  const receivedToken = authorization.slice("Bearer ".length).trim();
  return receivedToken.length > 0 && receivedToken === expectedToken;
}

function validateAllowedRepository(owner, repo, env) {
  const allowedRepository = requireEnv(env, "ALLOWED_REPOSITORY");
  return `${owner}/${repo}` === allowedRepository;
}

function parseBlobTransformPath(pathname) {
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

function decodeBase64Utf8(base64Content) {
  const binary = atob(base64Content.replace(/\s/g, ""));
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

function encodeUtf8Base64(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = "";

  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
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

  const response = await fetch(`${GITHUB_API_BASE}${path}`, {
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
    throw new Error(
      `GitHub API request failed: ${response.status} ${response.statusText} ${JSON.stringify(payload)}`
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
    throw new Error("GitHub blob response did not contain content.");
  }

  if (blob.encoding !== "base64") {
    throw new Error(`Unsupported GitHub blob encoding: ${blob.encoding}`);
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
      "content-type": "application/json"
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
      throw new Error("Each operation must be an object.");
    }

    const { type, search, replace } = operation;

    if (type !== "replace" && type !== "replaceRegex") {
      throw new Error(`Unsupported operation type: ${type}`);
    }

    if (typeof search !== "string") {
      throw new Error("Operation search must be a string.");
    }

    if (typeof replace !== "string") {
      throw new Error("Operation replace must be a string.");
    }

    if (type === "replace") {
      if (search.length === 0) {
        throw new Error("replace search must not be empty.");
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
    throw new Error("Patch does not contain a unified diff hunk.");
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
          throw new Error(
            `Patch context mismatch at source line ${sourceIndex + 1}.`
          );
        }

        outputLines.push(content);
        sourceIndex += 1;
      } else if (marker === "-") {
        if (sourceLines[sourceIndex] !== content) {
          throw new Error(
            `Patch removal mismatch at source line ${sourceIndex + 1}.`
          );
        }

        sourceIndex += 1;
      } else if (marker === "+") {
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
    throw new Error(
      `expected_sha mismatch: expected ${body.expected_sha}, got ${blob.sha}`
    );
  }

  if (
    typeof body.expected_size === "number" &&
    Number.isFinite(body.expected_size) &&
    body.expected_size !== blob.size
  ) {
    throw new Error(
      `expected_size mismatch: expected ${body.expected_size}, got ${blob.size}`
    );
  }
}

async function handleTransform(request, env, route) {
  const body = await request.json();

  if (!Array.isArray(body.operations) || body.operations.length === 0) {
    return errorResponse("Request body requires non-empty operations array.", 400);
  }

  const blob = await getGitBlob(route.owner, route.repo, route.fileSha, env);
  validateSafetyChecks(blob, body);

  const transformed = applyTextOperations(blob.text, body.operations);
  const outputSize = byteSizeUtf8(transformed.outputText);
  const dryRun = body.dry_run === true;

  if (dryRun) {
    return jsonResponse(
      {
        input_sha: blob.sha,
        input_size: blob.size,
        output_size: outputSize,
        operations: transformed.operations
      },
      200
    );
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
      input_sha: blob.sha,
      input_size: blob.size,
      output_sha: createdBlob.sha,
      output_size: outputSize,
      operations: transformed.operations
    },
    201
  );
}

async function handlePatch(request, env, route) {
  const body = await request.json();

  if (typeof body.patch !== "string" || body.patch.length === 0) {
    return errorResponse("Request body requires patch string.", 400);
  }

  const blob = await getGitBlob(route.owner, route.repo, route.fileSha, env);
  validateSafetyChecks(blob, body);

  const outputText = applyUnifiedDiff(blob.text, body.patch);
  const outputSize = byteSizeUtf8(outputText);
  const changed = outputText !== blob.text;
  const dryRun = body.dry_run === true;

  if (dryRun) {
    return jsonResponse(
      {
        input_sha: blob.sha,
        input_size: blob.size,
        output_size: outputSize,
        changed
      },
      200
    );
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
      input_sha: blob.sha,
      input_size: blob.size,
      output_sha: createdBlob.sha,
      output_size: outputSize,
      changed
    },
    201
  );
}

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);

      if (request.method === "GET" && url.pathname === "/health") {
        return jsonResponse({
          ok: true,
          service: "techcalc-blob-transformer"
        });
      }

      const route = parseBlobTransformPath(url.pathname);

      if (!route) {
        return errorResponse("Not found.", 404);
      }

      if (request.method !== "POST") {
        return errorResponse("Method not allowed.", 405);
      }

      if (!validateClientAuthorization(request, env)) {
        return errorResponse("Unauthorized.", 401);
      }

      if (!validateAllowedRepository(route.owner, route.repo, env)) {
        return errorResponse("Repository is not allowed.", 403, {
          repository: `${route.owner}/${route.repo}`
        });
      }

      if (route.action === "transform") {
        return handleTransform(request, env, route);
      }

      if (route.action === "patch") {
        return handlePatch(request, env, route);
      }

      return errorResponse("Unsupported action.", 404);
    } catch (error) {
      return errorResponse(
        error instanceof Error ? error.message : "Unexpected worker error.",
        500
      );
    }
  }
};
