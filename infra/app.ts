import { App } from "aws-cdk-lib";
import { configureApplication } from "./configuration";

const app = new App();
configureApplication(app);
app.synth();
