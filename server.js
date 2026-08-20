const { app, connectDatabase } = require("./app");

const PORT = process.env.PORT || 3000;

async function startServer() {
    try {
        await connectDatabase();

        app.listen(PORT, () => {
            console.log(
                `Server running at http://localhost:${PORT}`
            );

            console.log(
                `Swagger UI at http://localhost:${PORT}/api-docs`
            );
        });

    } catch (error) {
        console.error(
            "Failed to start server:",
            error
        );

        process.exit(1);
    }
}

startServer();