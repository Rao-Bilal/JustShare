import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';

export default function RootLayout() {
  return (
    <>
      <StatusBar style="light" />
      <Stack
        screenOptions={{
          headerStyle: {
            backgroundColor: '#0d1117',
          },
          headerTintColor: '#f0f6fc',
          headerTitleStyle: {
            fontWeight: '600',
          },
          contentStyle: {
            backgroundColor: '#0d1117',
          },
        }}
      >
        <Stack.Screen
          name="index"
          options={{
            title: 'JustShare',
          }}
        />
      </Stack>
    </>
  );
}
