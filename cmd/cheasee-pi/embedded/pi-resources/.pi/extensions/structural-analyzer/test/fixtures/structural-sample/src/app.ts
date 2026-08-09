class App {
	private name: string;

	constructor(name: string) {
		this.name = name;
	}

	greet(): void {
		console.log(`Hello from ${this.name}`);
	}

	start(): void {
		console.log("App started");
	}

	stop(): void {
		console.log("App stopped");
	}
}

function bootstrap(): App {
	const app = new App("MyApp");
	app.greet();
	app.start();
	return app;
}

// Entry point
bootstrap();
