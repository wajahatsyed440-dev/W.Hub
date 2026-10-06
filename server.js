require("dotenv").config();

const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const Database = require("better-sqlite3");
const cookieSession = require("cookie-session");
const Stripe = require("stripe");

const app = express();

const PORT = process.env.PORT || 3000;

const stripe = new Stripe(
  process.env.STRIPE_SECRET_KEY
);


/* =========================================================
   DATABASE
========================================================= */

const db = new Database(
  path.join(__dirname, "whub.db")
);

db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS purchases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    product TEXT NOT NULL,
    plan TEXT NOT NULL,
    stripe_customer_id TEXT,
    stripe_subscription_id TEXT,
    stripe_session_id TEXT UNIQUE,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL,

    FOREIGN KEY(user_id)
      REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS webhook_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    stripe_event_id TEXT UNIQUE NOT NULL,
    created_at TEXT NOT NULL
  );
`);


/* =========================================================
   PRODUCT CONFIG
========================================================= */

const PRODUCTS = {
  "W.Edits": {
    monthly: {
      price: process.env.STRIPE_EDITS_MONTHLY_PRICE,
      mode: "subscription"
    },

    once: {
      price: process.env.STRIPE_EDITS_ONCE_PRICE,
      mode: "payment"
    }
  },

  "W.Photo": {
    monthly: {
      price: process.env.STRIPE_PHOTO_MONTHLY_PRICE,
      mode: "subscription"
    },

    once: {
      price: process.env.STRIPE_PHOTO_ONCE_PRICE,
      mode: "payment"
    }
  }
};


/* =========================================================
   BASIC VALIDATION
========================================================= */

function productConfig(product, plan) {

  if (!PRODUCTS[product]) {
    throw new Error("Invalid product");
  }

  if (!PRODUCTS[product][plan]) {
    throw new Error("Invalid plan");
  }

  const config =
    PRODUCTS[product][plan];

  if (
    !config.price ||
    config.price.includes("REPLACE_ME")
  ) {
    throw new Error(
      "Stripe price has not been configured."
    );
  }

  return config;
}


/* =========================================================
   SESSION
========================================================= */

app.use(
  cookieSession({
    name: "whub_session",
    keys: [
      process.env.SESSION_SECRET
    ],
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge:
      1000 *
      60 *
      60 *
      24 *
      30
  })
);


/* =========================================================
   STRIPE WEBHOOK
=========================================================

IMPORTANT:
This MUST come before express.json().

Stripe signs the raw request body.
========================================================= */

app.post(
  "/stripe/webhook",

  express.raw({
    type: "application/json"
  }),

  (req, res) => {

    let event;

    try {

      event =
        stripe.webhooks.constructEvent(
          req.body,
          req.headers["stripe-signature"],
          process.env.STRIPE_WEBHOOK_SECRET
        );

    } catch (error) {

      console.error(
        "Webhook signature error:",
        error.message
      );

      return res
        .status(400)
        .send("Invalid webhook signature");
    }


    /* Prevent duplicate processing */

    const existing =
      db.prepare(`
        SELECT id
        FROM webhook_events
        WHERE stripe_event_id = ?
      `).get(event.id);

    if (existing) {
      return res.json({
        received: true
      });
    }


    try {

      switch (event.type) {

        case "checkout.session.completed":

          handleCheckoutCompleted(
            event.data.object
          );

          break;


        case "customer.subscription.deleted":

          handleSubscriptionDeleted(
            event.data.object
          );

          break;


        case "customer.subscription.updated":

          handleSubscriptionUpdated(
            event.data.object
          );

          break;
      }


      db.prepare(`
        INSERT INTO webhook_events
        (stripe_event_id, created_at)
        VALUES (?, ?)
      `).run(
        event.id,
        new Date().toISOString()
      );


      res.json({
        received: true
      });

    } catch (error) {

      console.error(
        "Webhook processing error:",
        error
      );

      res
        .status(500)
        .send("Webhook processing failed");
    }
  }
);


/* =========================================================
   NORMAL JSON
========================================================= */

app.use(
  express.json({
    limit: "1mb"
  })
);


/* =========================================================
   STATIC FRONTEND
========================================================= */

app.use(
  express.static(
    path.join(__dirname, "public")
  )
);


/* =========================================================
   AUTH HELPERS
========================================================= */

function getCurrentUser(req) {

  if (!req.session.userId) {
    return null;
  }

  return db.prepare(`
    SELECT id, email, created_at
    FROM users
    WHERE id = ?
  `).get(req.session.userId);
}


function requireLogin(req, res, next) {

  const user =
    getCurrentUser(req);

  if (!user) {

    return res.status(401).json({
      error: "You must be logged in."
    });
  }

  req.user = user;

  next();
}


/* =========================================================
   SIGN UP
========================================================= */

app.post(
  "/api/signup",
  async (req, res) => {

    try {

      const email =
        String(req.body.email || "")
          .trim()
          .toLowerCase();

      const password =
        String(req.body.password || "");


      if (!email || !email.includes("@")) {

        return res.status(400).json({
          error: "Enter a valid email."
        });
      }


      if (password.length < 8) {

        return res.status(400).json({
          error:
            "Password must be at least 8 characters."
        });
      }


      const existing =
        db.prepare(`
          SELECT id
          FROM users
          WHERE email = ?
        `).get(email);


      if (existing) {

        return res.status(409).json({
          error:
            "An account with that email already exists."
        });
      }


      const passwordHash =
        await bcrypt.hash(
          password,
          12
        );


      const result =
        db.prepare(`
          INSERT INTO users
          (email, password_hash, created_at)
          VALUES (?, ?, ?)
        `).run(
          email,
          passwordHash,
          new Date().toISOString()
        );


      req.session.userId =
        Number(result.lastInsertRowid);


      res.json({
        ok: true
      });

    } catch (error) {

      console.error(error);

      res.status(500).json({
        error: "Could not create account."
      });
    }
  }
);


/* =========================================================
   LOGIN
========================================================= */

app.post(
  "/api/login",
  async (req, res) => {

    try {

      const email =
        String(req.body.email || "")
          .trim()
          .toLowerCase();

      const password =
        String(req.body.password || "");


      const user =
        db.prepare(`
          SELECT *
          FROM users
          WHERE email = ?
        `).get(email);


      if (!user) {

        return res.status(401).json({
          error:
            "Email or password is incorrect."
        });
      }


      const valid =
        await bcrypt.compare(
          password,
          user.password_hash
        );


      if (!valid) {

        return res.status(401).json({
          error:
            "Email or password is incorrect."
        });
      }


      req.session.userId =
        user.id;


      res.json({
        ok: true
      });

    } catch (error) {

      console.error(error);

      res.status(500).json({
        error: "Login failed."
      });
    }
  }
);


/* =========================================================
   LOGOUT
========================================================= */

app.post(
  "/api/logout",
  (req, res) => {

    req.session = null;

    res.json({
      ok: true
    });
  }
);


/* =========================================================
   CURRENT ACCOUNT
========================================================= */

app.get(
  "/api/me",
  (req, res) => {

    const user =
      getCurrentUser(req);


    if (!user) {

      return res.json({
        loggedIn: false
      });
    }


    const purchases =
      db.prepare(`
        SELECT
          product,
          plan,
          status,
          created_at
        FROM purchases
        WHERE user_id = ?
          AND status = 'active'
        ORDER BY created_at DESC
      `).all(user.id);


    res.json({
      loggedIn: true,
      user: {
        id: user.id,
        email: user.email,
        created_at: user.created_at
      },
      purchases
    });
  }
);


/* =========================================================
   CREATE REAL STRIPE CHECKOUT
========================================================= */

app.post(
  "/api/checkout",
  requireLogin,
  async (req, res) => {

    try {

      const product =
        String(req.body.product || "");

      const plan =
        String(req.body.plan || "");


      const config =
        productConfig(
          product,
          plan
        );


      /*
        Customer is attached to their W.HUB account.
      */

      const customer =
        await stripe.customers.create({
          email: req.user.email,
          metadata: {
            whub_user_id:
              String(req.user.id)
          }
        });


      const session =
        await stripe.checkout.sessions.create({

          mode: config.mode,

          customer:
            customer.id,

          line_items: [
            {
              price: config.price,
              quantity: 1
            }
          ],

          success_url:
            process.env.BASE_URL +
            "/?payment=success",

          cancel_url:
            process.env.BASE_URL +
            "/?payment=cancelled",

          metadata: {
            whub_user_id:
              String(req.user.id),

            product,
            plan
          },

          allow_promotion_codes: true
        });


      res.json({
        url: session.url
      });

    } catch (error) {

      console.error(error);

      res.status(500).json({
        error:
          error.message ||
          "Could not create checkout."
      });
    }
  }
);


/* =========================================================
   CHECKOUT WEBHOOK
========================================================= */

function handleCheckoutCompleted(session) {

  const userId =
    Number(
      session.metadata?.whub_user_id
    );

  const product =
    session.metadata?.product;

  const plan =
    session.metadata?.plan;


  if (
    !userId ||
    !product ||
    !plan
  ) {

    console.error(
      "Checkout missing metadata."
    );

    return;
  }


  const existing =
    db.prepare(`
      SELECT id
      FROM purchases
      WHERE stripe_session_id = ?
    `).get(session.id);


  if (existing) {
    return;
  }


  db.prepare(`
    INSERT INTO purchases (
      user_id,
      product,
      plan,
      stripe_customer_id,
      stripe_subscription_id,
      stripe_session_id,
      status,
      created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, 'active', ?)
  `).run(

    userId,

    product,

    plan,

    session.customer || null,

    session.subscription || null,

    session.id,

    new Date().toISOString()
  );
}


/* =========================================================
   SUBSCRIPTION CANCELLED
========================================================= */

function handleSubscriptionDeleted(
  subscription
) {

  db.prepare(`
    UPDATE purchases
    SET status = 'cancelled'
    WHERE stripe_subscription_id = ?
  `).run(
    subscription.id
  );
}


/* =========================================================
   SUBSCRIPTION UPDATED
========================================================= */

function handleSubscriptionUpdated(
  subscription
) {

  let status =
    "active";


  if (
    subscription.status === "canceled" ||
    subscription.status === "unpaid"
  ) {

    status = "cancelled";
  }


  db.prepare(`
    UPDATE purchases
    SET status = ?
    WHERE stripe_subscription_id = ?
  `).run(
    status,
    subscription.id
  );
}


/* =========================================================
   CHECK OWNERSHIP
========================================================= */

function ownsProduct(
  userId,
  product
) {

  const result =
    db.prepare(`
      SELECT id
      FROM purchases
      WHERE user_id = ?
        AND product = ?
        AND status = 'active'
      LIMIT 1
    `).get(
      userId,
      product
    );

  return !!result;
}


/* =========================================================
   PROTECTED DOWNLOADS
========================================================= */

app.get(
  "/download/w-edits",
  requireLogin,
  (req, res) => {

    if (
      !ownsProduct(
        req.user.id,
        "W.Edits"
      )
    ) {

      return res.status(403).send(
        "You do not own W.Edits."
      );
    }


    const file =
      path.join(
        __dirname,
        "apps",
        "w-edits.html"
      );


    res.download(
      file,
      "W.Edits.html"
    );
  }
);


app.get(
  "/download/w-photo",
  requireLogin,
  (req, res) => {

    if (
      !ownsProduct(
        req.user.id,
        "W.Photo"
      )
    ) {

      return res.status(403).send(
        "You do not own W.Photo."
      );
    }


    const file =
      path.join(
        __dirname,
        "apps",
        "w-photo.html"
      );


    res.download(
      file,
      "W.Photo.html"
    );
  }
);


/* =========================================================
   HEALTH CHECK
========================================================= */

app.get(
  "/api/health",
  (req, res) => {

    res.json({
      ok: true,
      service: "W.HUB"
    });
  }
);


/* =========================================================
   START
========================================================= */

app.listen(
  PORT,
  () => {

    console.log(
      `W.HUB running at http://localhost:${PORT}`
    );
  }
);
