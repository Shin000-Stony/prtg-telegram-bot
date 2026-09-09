require("dotenv").config();

require("../database/init");
require("../database/seed");

const customers = require("../database/customers");
const { mapCustomer } = require("./mapper");
const { saveMapping, getInventorySummary } = require("./inventory");
const { isPrtgScope } = require("../constants/scopes");

async function build() {

    console.log("=== BUILD MAPPING INVENTORY ===\n");

    const all = customers.getEnabled();
    console.log("Total enabled customers:", all.length);
    console.log("");

    const results = [];

    for (const customer of all) {

        if (!isPrtgScope(customer.monitoring_scope)) {

            console.log(
                `Mapping #${customer.client_id} ${customer.name}... ` +
                `SKIPPED (scope: ${customer.monitoring_scope || "prtg"})`
            );

            continue;
        }

        process.stdout.write(`Mapping #${customer.client_id} ${customer.name}... `);

        try {

            const result = await mapCustomer(customer);

            saveMapping(customer.id, result);

            results.push({
                clientId: customer.client_id,
                name: customer.name,
                status: result.status
            });

            console.log(result.status.toUpperCase());

        } catch (error) {

            results.push({
                clientId: customer.client_id,
                name: customer.name,
                status: "error",
                error: error.message
            });

            console.log("ERROR:", error.message);
        }
    }

    console.log("\n" + "=".repeat(80));
    console.log("BUILD COMPLETE");
    console.log("=".repeat(80));

    const { summary } = getInventorySummary();

    console.log(`Mapped   : ${summary.mapped}`);
    console.log(`Unmapped : ${summary.unmapped}`);
    console.log(`Ambiguous: ${summary.ambiguous}`);
    console.log(`Total    : ${summary.total}`);
}

build().catch(error => {
    console.error("\nFATAL ERROR:", error);
    process.exit(1);
});