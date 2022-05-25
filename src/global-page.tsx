import ForgeUI, { Fragment, render, Text, useState, useAction, Form, TextField } from '@forge/ui';
import { webTrigger, storage } from "@forge/api";


const App = () => {
  const [url] = useState(async () => webTrigger.getUrl('trigger-sync'));

  return (
    <Fragment>
      <Text>Webhook Url: {url}</Text>
      <Form onSubmit={setApiToken}>
        <TextField name="apiToken" label="API Token" type='password' />
      </Form>
    </Fragment>
  );
};

const setApiToken = ({ apiToken } : { apiToken: string }) => {
  return storage.setSecret('api-token', apiToken);
}

export const run = render(
  <App/>
);
