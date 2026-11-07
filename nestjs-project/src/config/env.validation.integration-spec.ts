import { envValidationSchema } from './env.validation';

const requiredEnv = {
  DB_USERNAME: 'user',
  DB_PASSWORD: 'pass',
  DB_NAME: 'db',
  JWT_SECRET: 'secret',
  JWT_REFRESH_SECRET: 'refresh-secret',
  S3_ENDPOINT: 'http://minio:9000',
  S3_PUBLIC_ENDPOINT: 'http://localhost:9000',
  S3_REGION: 'us-east-1',
  S3_ACCESS_KEY: 'access',
  S3_SECRET_KEY: 'secret-key',
  S3_BUCKET_VIDEOS: 'videos',
  S3_BUCKET_THUMBNAILS: 'thumbnails',
  REDIS_HOST: 'redis',
  REDIS_PORT: '6379',
};

const validate = (env: Record<string, string>) =>
  envValidationSchema.validate(
    { ...requiredEnv, ...env },
    { allowUnknown: true, abortEarly: false },
  );

describe('envValidationSchema — SWAGGER_ENABLED', () => {
  it('should reject SWAGGER_ENABLED with an invalid value', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'invalid' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('SWAGGER_ENABLED');
  });

  it('should accept SWAGGER_ENABLED=true', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'true' });
    expect(error).toBeUndefined();
  });

  it('should accept SWAGGER_ENABLED=false', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'false' });
    expect(error).toBeUndefined();
  });

  it('should apply default false when SWAGGER_ENABLED is not set', () => {
    const { value, error } = validate({}) as {
      value: { SWAGGER_ENABLED: string };
      error?: unknown;
    };
    expect(error).toBeUndefined();
    expect(value.SWAGGER_ENABLED).toBe('false');
  });
});

describe('envValidationSchema — storage and queue keys', () => {
  const storageAndQueueKeys = [
    'S3_ENDPOINT',
    'S3_PUBLIC_ENDPOINT',
    'S3_REGION',
    'S3_ACCESS_KEY',
    'S3_SECRET_KEY',
    'S3_BUCKET_VIDEOS',
    'S3_BUCKET_THUMBNAILS',
    'REDIS_HOST',
    'REDIS_PORT',
  ];

  const validateWithout = (key: string) => {
    const env: Record<string, string> = { ...requiredEnv };
    delete env[key];
    return envValidationSchema.validate(env, {
      allowUnknown: true,
      abortEarly: false,
    });
  };

  it.each(storageAndQueueKeys)(
    'should reject the env when %s is missing',
    (key) => {
      const { error } = validateWithout(key);
      expect(error).toBeDefined();
      expect(error!.message).toContain(key);
    },
  );

  it('should accept the env when every storage and queue key is present', () => {
    const { error } = validate({});
    expect(error).toBeUndefined();
  });

  it('should reject S3_PUBLIC_ENDPOINT that is not a URI', () => {
    const { error } = validate({ S3_PUBLIC_ENDPOINT: 'not a uri' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('S3_PUBLIC_ENDPOINT');
  });
});
