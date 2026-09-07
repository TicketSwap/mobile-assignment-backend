import "dotenv/config";
import { randomBytes } from "node:crypto";
import { createReadStream, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { createSchema, createYoga } from "graphql-yoga";
import { createServer } from "node:http";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataPath = join(__dirname, "data.json");
const usersPath = join(__dirname, "users.json");
const venuesPath = join(__dirname, "venues.json");
const schemaPath = join(__dirname, "schema.graphql");
const imagesDir = join(__dirname, "images");

const env = {
  errorRate: Math.min(100, Math.max(0, Number(process.env.ERROR_RATE ?? 0))),
  minDelayMs: Math.max(0, Math.floor(Number(process.env.MIN_DELAY_MS ?? 0))),
};

/** Simulated failure copy; used when ERROR_RATE triggers before your resolver runs. */
const MOCK_FAILURE = { text: "Request failed (simulated)." };

function shouldMockFail() {
  return Math.random() * 100 < env.errorRate;
}

async function beforeEveryOp() {
  if (env.minDelayMs > 0) {
    await new Promise((r) => setTimeout(r, env.minDelayMs));
  }
}

/** Deep clone of event/ticket data from file; updated in memory when tickets are added to cart. */
const catalog = structuredClone(JSON.parse(readFileSync(dataPath, "utf8")));
const userRecords = JSON.parse(readFileSync(usersPath, "utf8"));
const venuesData = JSON.parse(readFileSync(venuesPath, "utf8"));

/** @type {Map<string, {id: string, name: string}>} venue id -> venue record */
const venuesById = new Map(venuesData.venues.map((v) => [v.id, v]));

/** @type {Map<string, string>} accessToken -> username (demo only; not for production) */
const activeSessions = new Map();

/** @type {Map<string, Array<CartLineData>>} username -> cart lines */
const userCarts = new Map();

/** @type {Map<string, Array<OwnedTicketData>>} user id (e.g. usr_1) -> purchased tickets */
const userWallets = new Map();

// NOTE: storing raw PANs in memory is for this assignment only. In production a
// payment processor token (e.g. Stripe payment method id) would be stored instead.
/** @type {Map<string, string>} username -> saved credit card number */
const userCreditCards = new Map();

/**
 * @typedef {object} CartLineData
 * @property {string} ticketId
 * @property {string} eventId
 * @property {string} eventTitle
 * @property {string} ticketLabel
 * @property {number} priceCents
 * @property {string} currency
 */

/**
 * @typedef {object} OwnedTicketData
 * @property {string} id
 * @property {string} label
 * @property {number} priceCents
 * @property {string} currency
 * @property {string} barcode EAN-13 (13 digits, valid check digit)
 */

/**
 * GS1 GTIN-13 check digit: positions 1–12 from the left, multiply by 1,3,1,3,…
 * (GS1: odd positions from the left ×1, even positions ×3).
 * @param {string} twelveDigits
 * @returns {number} 0–9
 */
function ean13CheckDigitFrom12(twelveDigits) {
  if (twelveDigits.length !== 12) {
    throw new Error("EAN-13 check needs exactly 12 data digits.");
  }
  let sum = 0;
  for (let i = 0; i < 12; i += 1) {
    const w = i % 2 === 0 ? 1 : 3;
    sum += Number(twelveDigits[i]) * w;
  }
  return (10 - (sum % 10)) % 10;
}

/**
 * @param {string} s
 * @returns {boolean}
 */
function isValidEan13(s) {
  if (!/^\d{13}$/.test(s)) {
    return false;
  }
  return ean13CheckDigitFrom12(s.slice(0, 12)) === Number(s[12]);
}

/** Returns a 13-digit EAN-13 with a correct GS1 mod-10 check digit (verifiable with scanners/validators). */
function generateEan13Barcode() {
  let digits = "";
  for (let i = 0; i < 12; i += 1) {
    digits += Math.floor(Math.random() * 10);
  }
  const check = ean13CheckDigitFrom12(digits);
  const full = `${digits}${check}`;
  if (!isValidEan13(full)) {
    throw new Error("EAN-13 internal check failed.");
  }
  return full;
}

function findUserByUsername(username) {
  return userRecords.users.find((u) => u.username === username) ?? null;
}

function toPublicUser(row) {
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    firstName: row.firstName,
    lastName: row.lastName,
    age: row.age,
    username: row.username,
  };
}

/** Resolve a bearer access token to a public user, or an [Error] shape. */
function getSessionWithError(accessToken) {
  if (!accessToken || !String(accessToken).trim()) {
    return { user: null, error: { text: "Missing or invalid access token." } };
  }
  const username = activeSessions.get(accessToken.trim());
  if (!username) {
    return { user: null, error: { text: "Invalid or unknown access token." } };
  }
  const row = findUserByUsername(username);
  if (!row) {
    return { user: null, error: { text: "Session is corrupted." } };
  }
  return { user: toPublicUser(row), error: null };
}

/**
 * Find a ticket in the in-memory catalog.
 * @returns {{ event: object, ticket: object } | null}
 */
function findTicketInCatalog(ticketId) {
  for (const event of catalog.events) {
    const t = (event.tickets ?? []).find((x) => x.id === ticketId);
    if (t) {
      return { event, ticket: t };
    }
  }
  return null;
}

function getOrCreateCart(username) {
  if (!userCarts.has(username)) {
    userCarts.set(username, []);
  }
  return userCarts.get(username);
}

function toGraphqlCart(username) {
  const lines = getOrCreateCart(username);
  return { lines: lines.map((line) => ({ ...line })) };
}

function luhnCheck(digits) {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let n = Number(digits[i]);
    if (Number.isNaN(n)) {
      return false;
    }
    if (alt) {
      n *= 2;
      if (n > 9) {
        n -= 9;
      }
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

function isPlausibleCardNumber(raw) {
  const digits = String(raw).replace(/\D/g, "");
  if (digits.length < 12 || digits.length > 19) {
    return false;
  }
  return luhnCheck(digits);
}

const typeDefs = readFileSync(schemaPath, "utf8");

function ticketsAvailableForPurchase(tickets) {
  return (tickets ?? []).filter((t) => t.quantityAvailable > 0);
}

function searchEventsByTitle(query) {
  const needle = query.trim();
  if (!needle) {
    return [];
  }
  const lower = needle.toLowerCase();
  return catalog.events.filter((e) => e.title.toLowerCase().includes(lower));
}

/** Build an absolute URL for a static image, using the incoming request's host so it works behind any port/proxy. */
function buildImageUrl(ctx, imageFile) {
  const headers = ctx?.request?.headers;
  const host = headers?.get?.("host") ?? `localhost:${process.env.PORT ?? 4000}`;
  const proto = headers?.get?.("x-forwarded-proto") ?? "http";
  return `${proto}://${host}/images/${imageFile}`;
}

const resolvers = {
  Query: {
    events: async () => {
      await beforeEveryOp();
      if (shouldMockFail()) {
        return { events: [], error: MOCK_FAILURE };
      }
      return { events: catalog.events, error: null };
    },
    event: async (_parent, args) => {
      await beforeEveryOp();
      if (shouldMockFail()) {
        return { event: null, error: MOCK_FAILURE };
      }
      const ev = catalog.events.find((e) => e.id === args.id) ?? null;
      return { event: ev, error: null };
    },
    searchEvents: async (_parent, args) => {
      await beforeEveryOp();
      if (shouldMockFail()) {
        return { events: [], error: MOCK_FAILURE };
      }
      return { events: searchEventsByTitle(args.query), error: null };
    },
    ticketsForPurchase: async (_parent, args) => {
      await beforeEveryOp();
      if (shouldMockFail()) {
        return { tickets: [], error: MOCK_FAILURE };
      }
      const raw = args.query;
      const needle = raw == null || raw === "" ? "" : String(raw).trim();
      const { events } = catalog;
      const out = [];
      for (const ev of events) {
        if (needle) {
          if (!ev.title.toLowerCase().includes(needle.toLowerCase())) {
            continue;
          }
        }
        for (const t of ticketsAvailableForPurchase(ev.tickets)) {
          out.push({
            eventId: ev.id,
            eventTitle: ev.title,
            ticket: t,
          });
        }
      }
      return { tickets: out, error: null };
    },
  },
  Event: {
    tickets: (parent) => parent.tickets ?? [],
    venue: (parent) => venuesById.get(parent.venueId) ?? null,
    imageUrl: (parent, _args, ctx) => buildImageUrl(ctx, parent.imageFile),
  },
  Venue: {
    imageUrl: (parent, _args, ctx) => buildImageUrl(ctx, parent.imageFile),
  },
  User: {
    ticketWallet: (parent) => userWallets.get(parent.id) ?? [],
    cart: (parent) => {
      const lines = userCarts.get(parent.username) ?? [];
      return lines.map((line) => ({ ...line }));
    },
    walletTicketCount: (parent) => {
      const w = userWallets.get(parent.id);
      return w ? w.length : 0;
    },
    creditCardNumber: (parent) => userCreditCards.get(parent.username) ?? null,
  },
  Mutation: {
    login: async (_parent, args) => {
      await beforeEveryOp();
      if (shouldMockFail()) {
        return { accessToken: null, error: MOCK_FAILURE };
      }
      const { username, password } = args;
      const user = findUserByUsername(username);
      if (!user || user.password !== password) {
        return {
          accessToken: null,
          error: { text: "Invalid username or password." },
        };
      }
      const accessToken = randomBytes(32).toString("hex");
      activeSessions.set(accessToken, user.username);
      return { accessToken, error: null };
    },
    logout: async (_parent, args) => {
      await beforeEveryOp();
      if (shouldMockFail()) {
        return { ok: false, error: MOCK_FAILURE };
      }
      const { accessToken } = args;
      const { error } = getSessionWithError(accessToken);
      if (error) {
        return { ok: false, error };
      }
      activeSessions.delete(accessToken.trim());
      return { ok: true, error: null };
    },
    authenticatedUser: async (_parent, args) => {
      await beforeEveryOp();
      if (shouldMockFail()) {
        return { user: null, error: MOCK_FAILURE };
      }
      return getSessionWithError(args.accessToken);
    },
    addTicketToCart: async (_parent, args) => {
      await beforeEveryOp();
      if (shouldMockFail()) {
        return { error: MOCK_FAILURE, cart: null };
      }
      const { accessToken, ticketId } = args;
      const session = getSessionWithError(accessToken);
      if (session.error) {
        return { error: session.error, cart: null };
      }
      const username = session.user.username;
      const found = findTicketInCatalog(ticketId);
      if (!found) {
        return { error: { text: "Unknown ticket id." }, cart: toGraphqlCart(username) };
      }
      const { event, ticket } = found;
      if (ticket.quantityAvailable <= 0) {
        return {
          error: { text: "This ticket is sold out." },
          cart: toGraphqlCart(username),
        };
      }
      ticket.quantityAvailable -= 1;
      const line = {
        ticketId: ticket.id,
        eventId: event.id,
        eventTitle: event.title,
        ticketLabel: ticket.label,
        priceCents: ticket.priceCents,
        currency: ticket.currency,
      };
      getOrCreateCart(username).push(line);
      return { error: null, cart: toGraphqlCart(username) };
    },
    removeTicketFromCart: async (_parent, args) => {
      await beforeEveryOp();
      if (shouldMockFail()) {
        return { error: MOCK_FAILURE, cart: null };
      }
      const { accessToken, ticketId } = args;
      const session = getSessionWithError(accessToken);
      if (session.error) {
        return { error: session.error, cart: null };
      }
      const username = session.user.username;
      const found = findTicketInCatalog(ticketId);
      if (!found) {
        return { error: { text: "Unknown ticket id." }, cart: toGraphqlCart(username) };
      }
      const cart = getOrCreateCart(username);
      // Each cart line is one unit, so one call removes one unit (the first match).
      const index = cart.findIndex((line) => line.ticketId === ticketId);
      if (index === -1) {
        return {
          error: { text: "This ticket is not in your cart." },
          cart: toGraphqlCart(username),
        };
      }
      cart.splice(index, 1);
      found.ticket.quantityAvailable += 1;
      return { error: null, cart: toGraphqlCart(username) };
    },
    checkout: async (_parent, args) => {
      await beforeEveryOp();
      if (shouldMockFail()) {
        return { error: MOCK_FAILURE, purchasedTickets: null };
      }
      const { accessToken, creditCardNumber } = args;
      const session = getSessionWithError(accessToken);
      if (session.error) {
        return { error: session.error, purchasedTickets: null };
      }
      if (!isPlausibleCardNumber(creditCardNumber)) {
        return {
          error: { text: "Invalid or unsupported credit card number." },
          purchasedTickets: null,
        };
      }
      const userId = session.user.id;
      const username = session.user.username;
      const cart = getOrCreateCart(username);
      if (cart.length === 0) {
        return { error: { text: "Cart is empty." }, purchasedTickets: null };
      }
      if (!userWallets.has(userId)) {
        userWallets.set(userId, []);
      }
      const wallet = userWallets.get(userId);
      const added = [];
      for (const line of cart) {
        const item = {
          id: `wlt_${randomBytes(9).toString("hex")}`,
          label: line.ticketLabel,
          priceCents: line.priceCents,
          currency: line.currency,
          barcode: generateEan13Barcode(),
        };
        wallet.push(item);
        added.push({ ...item });
      }
      cart.length = 0;
      return { error: null, purchasedTickets: added };
    },
    saveCreditCard: async (_parent, args) => {
      await beforeEveryOp();
      if (shouldMockFail()) {
        return { error: MOCK_FAILURE, user: null };
      }
      const { accessToken, creditCardNumber } = args;
      const session = getSessionWithError(accessToken);
      if (session.error) {
        return { error: session.error, user: null };
      }
      if (!isPlausibleCardNumber(creditCardNumber)) {
        return {
          error: { text: "Invalid or unsupported credit card number." },
          user: null,
        };
      }
      userCreditCards.set(session.user.username, String(creditCardNumber));
      return { error: null, user: session.user };
    },
  },
};

const schema = createSchema({ typeDefs, resolvers });

const yoga = createYoga({
  schema,
  graphiql: {
    defaultQuery: /* GraphQL */ `# 1) Login  2) copy accessToken  3) add ticket  4) checkout
query Catalog {
  events {
    events { id
      tickets { id label quantityAvailable }
    }
    error { text }
  }
}

mutation Login {
  login(username: "ada", password: "chartreuse") {
    accessToken
    error { text }
  }
}

mutation AddCart($t: String!, $tk: ID!) {
  addTicketToCart(accessToken: $t, ticketId: $tk) {
    error { text }
    cart { lines { ticketId eventTitle ticketLabel priceCents } }
  }
}

mutation RemoveCart($t: String!, $tk: ID!) {
  removeTicketFromCart(accessToken: $t, ticketId: $tk) {
    error { text }
    cart { lines { ticketId eventTitle ticketLabel priceCents } }
  }
}

mutation Pay($t: String!, $cc: String!) {
  checkout(accessToken: $t, creditCardNumber: $cc) {
    error { text }
    purchasedTickets { id label priceCents currency barcode }
  }
}

query Me($t: String!) {
  authenticatedUser(accessToken: $t) {
    user {
      firstName
      cart { ticketId eventId eventTitle ticketLabel priceCents currency }
      ticketWallet { id label priceCents currency barcode }
    }
    error { text }
  }
}
`,
  },
});

function tryServeImage(req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    return false;
  }
  const url = new URL(req.url, "http://placeholder");
  if (!url.pathname.startsWith("/images/")) {
    return false;
  }
  // Resolve and ensure the result stays inside imagesDir (defense against `..` traversal).
  const requested = resolvePath(imagesDir, url.pathname.slice("/images/".length));
  if (!requested.startsWith(imagesDir + "/") && requested !== imagesDir) {
    res.statusCode = 403;
    res.end();
    return true;
  }
  let stat;
  try {
    stat = statSync(requested);
  } catch {
    res.statusCode = 404;
    res.end();
    return true;
  }
  if (!stat.isFile()) {
    res.statusCode = 404;
    res.end();
    return true;
  }
  res.statusCode = 200;
  res.setHeader("Content-Type", "image/jpeg");
  res.setHeader("Content-Length", stat.size);
  res.setHeader("Cache-Control", "public, max-age=86400");
  if (req.method === "HEAD") {
    res.end();
    return true;
  }
  createReadStream(requested).pipe(res);
  return true;
}

const server = createServer((req, res) => {
  if (tryServeImage(req, res)) {
    return;
  }
  return yoga(req, res);
});
const port = process.env.PORT ? Number(process.env.PORT) : 4000;

server.listen(port, () => {
  console.log(
    `Server ready at http://localhost:${port}/graphql (GraphiQL in the browser) — ERROR_RATE=${env.errorRate} MIN_DELAY_MS=${env.minDelayMs}`,
  );
});
