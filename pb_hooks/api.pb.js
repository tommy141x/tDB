/// <reference path="../pb_data/types.d.ts" />

// Batch record reads, record transactions, custom realtime messages, email.
//
// The old /api/sql/* routes are gone: they made the caller declare the result
// shape up front, because PocketBase's JSVM cannot scan into an undeclared
// model, so a wrong declaration silently changed the data. tdb-routes.pb.js
// replaces them with /api/tdb/{query,execute,batch,schema}, which read the
// shape from SQLite itself.

// Body: { collection, ids[] }
routerAdd(
  "POST",
  "/api/records/findByIds",
  (e) => {
    try {
      const body = e.requestInfo().body;
      const { collection, ids } = body;

      if (!collection || !ids || !Array.isArray(ids)) {
        throw new BadRequestError("Collection and ids array are required");
      }

      const records = $app.findRecordsByIds(collection, ids);

      return e.json(200, {
        success: true,
        data: records.map((r) => r.publicExport()),
      });
    } catch (error) {
      console.error("findByIds error:", error);
      return e.json(400, {
        success: false,
        error: error.message || String(error),
      });
    }
  },
  $apis.requireSuperuserAuth(),
);

// Body: { collection, filter?, params? }
routerAdd(
  "POST",
  "/api/records/count",
  (e) => {
    try {
      const body = e.requestInfo().body;
      const { collection, filter, params } = body;

      if (!collection) {
        throw new BadRequestError("Collection is required");
      }

      let count = 0;

      if (filter) {
        const records = $app.findRecordsByFilter(
          collection,
          filter,
          "",
          999999,
          0,
          params || {},
        );
        count = records.length;
      } else {
        count = $app.countRecords(collection);
      }

      return e.json(200, {
        success: true,
        count: count,
      });
    } catch (error) {
      console.error("Count error:", error);
      return e.json(400, {
        success: false,
        error: error.message || String(error),
      });
    }
  },
  $apis.requireSuperuserAuth(),
);

// Body: { operations: [{ type: create|update|delete, collection, id?, data? }] }
routerAdd(
  "POST",
  "/api/transactions/run",
  (e) => {
    try {
      const body = e.requestInfo().body;
      const { operations } = body;

      if (!operations || !Array.isArray(operations)) {
        throw new BadRequestError("Operations array is required");
      }

      const results = [];

      $app.runInTransaction((txApp) => {
        for (let i = 0; i < operations.length; i++) {
          const op = operations[i];
          const { type, collection, id, data: opData } = op;

          if (!type || !collection) {
            throw new BadRequestError(
              `Operation at index ${i} is missing type or collection`,
            );
          }

          let result = null;

          if (type === "create") {
            const coll = txApp.findCollectionByNameOrId(collection);
            const record = new Record(coll);

            if (opData && typeof opData === "object") {
              for (const key in opData) {
                record.set(key, opData[key]);
              }
            }

            txApp.save(record);
            result = { id: record.id };
          } else if (type === "update") {
            if (!id) {
              throw new BadRequestError(
                `Update operation at index ${i} is missing id`,
              );
            }

            const record = txApp.findRecordById(collection, id);

            if (opData && typeof opData === "object") {
              for (const key in opData) {
                record.set(key, opData[key]);
              }
            }

            txApp.save(record);
            result = { id: record.id };
          } else if (type === "delete") {
            if (!id) {
              throw new BadRequestError(
                `Delete operation at index ${i} is missing id`,
              );
            }

            const record = txApp.findRecordById(collection, id);
            txApp.delete(record);
            result = { deleted: true };
          } else {
            throw new BadRequestError(`Unknown operation type: ${type}`);
          }

          results.push(result);
        }
      });

      return e.json(200, {
        success: true,
        results: results,
      });
    } catch (error) {
      console.error("Transaction error:", error);
      return e.json(400, {
        success: false,
        error: error.message || String(error),
      });
    }
  },
  $apis.requireSuperuserAuth(),
);

// Fans a message out to every client subscribed to the topic.
// Body: { topic, data }
routerAdd(
  "POST",
  "/api/realtime/send",
  (e) => {
    try {
      const body = e.requestInfo().body;
      const { topic, data: messageData } = body;

      if (!topic) {
        throw new BadRequestError("Topic is required");
      }

      const message = new SubscriptionMessage({
        name: topic,
        data: JSON.stringify(messageData),
      });

      const clients = $app.subscriptionsBroker().clients();
      let sentCount = 0;

      for (const clientId in clients) {
        if (clients[clientId].hasSubscription(topic)) {
          clients[clientId].send(message);
          sentCount++;
        }
      }

      return e.json(200, {
        success: true,
        sentCount: sentCount,
      });
    } catch (error) {
      console.error("Realtime send error:", error);
      return e.json(400, {
        success: false,
        error: error.message || String(error),
      });
    }
  },
  $apis.requireSuperuserAuth(),
);

routerAdd(
  "GET",
  "/api/realtime/clients",
  (e) => {
    try {
      const clients = $app.subscriptionsBroker().clients();
      const clientsInfo = [];

      for (const clientId in clients) {
        const client = clients[clientId];
        const auth = client.get("auth");

        clientsInfo.push({
          id: clientId,
          authenticated: !!auth,
          authId: auth ? auth.id : null,
        });
      }

      return e.json(200, {
        success: true,
        clients: clientsInfo,
        count: clientsInfo.length,
      });
    } catch (error) {
      console.error("Get clients error:", error);
      return e.json(400, {
        success: false,
        error: error.message || String(error),
      });
    }
  },
  $apis.requireSuperuserAuth(),
);

// Body: { to: string|string[], subject, html?, text? }
routerAdd(
  "POST",
  "/api/email/send",
  (e) => {
    try {
      const body = e.requestInfo().body;
      const { to, subject, html, text } = body;

      if (!to || !subject || (!html && !text)) {
        throw new BadRequestError("To, subject, and html/text are required");
      }

      const toArray = Array.isArray(to) ? to : [to];

      const message = new MailerMessage({
        from: {
          address: $app.settings().meta.senderAddress,
          name: $app.settings().meta.senderName,
        },
        to: toArray.map((email) => ({ address: email })),
        subject: subject,
        html: html || "",
        text: text || "",
      });

      $app.newMailClient().send(message);

      return e.json(200, {
        success: true,
      });
    } catch (error) {
      console.error("Email send error:", error);
      return e.json(400, {
        success: false,
        error: error.message || String(error),
      });
    }
  },
  $apis.requireSuperuserAuth(),
);

// Answering at all is the signal: it proves --hooksDir resolved and this file
// was loaded. server.js reads `status` and nothing else.
routerAdd("GET", "/api/extended/health", (e) => {
  return e.json(200, { status: "ok" });
});
