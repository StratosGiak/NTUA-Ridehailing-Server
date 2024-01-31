import mysql from "mysql2";
import dotenv from "dotenv";
if (process.env.NODE_ENV === "production") {
  dotenv.config({ path: "./.env.production" });
} else {
  dotenv.config({ path: "./.env.development" });
}

const pool = mysql
  .createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PWD,
    database: process.env.DB_DBNAME,
  })
  .promise();

export async function getAllUsers() {
  const [users] = await pool.query("SELECT * FROM users");
  const [cars] = await pool.query("SELECT * FROM cars");
  const result = users.map(function (user, _) {
    user.cars = cars
      .filter((car) => car.user_id == user.id)
      .reduce(function (map, car) {
        map[car.car_id] = car;
        delete car.user_id;
        delete car.car_id;
        return map;
      }, {});
    return user;
  });
  return result.reduce(function (map, obj) {
    map[obj.id] = obj;
    return map;
  }, {});
}

export async function getUser(user_id) {
  const [user] = await pool.query(`SELECT * FROM users WHERE id = ?`, [
    user_id,
  ]);
  const [cars] = await pool.query(`SELECT * FROM cars WHERE user_id = ?`, [
    user_id,
  ]);
  user[0].cars = cars.reduce(function (map, car) {
    map[car.car_id] = car;
    delete car.user_id;
    delete car.car_id;
    return map;
  }, {});
  return user[0];
}

export async function getUserCar(car_id) {
  const [car] = await pool.query(`SELECT * FROM cars WHERE car_id = ?`, [
    car_id,
  ]);
  delete car[0].user_id;
  return car[0];
}

export async function createUser(user_id, name, token) {
  const [result, fields] = await pool.query(
    `INSERT INTO users (id, name, token) VALUES (?, ?, ?)`,
    [user_id, name, token]
  );
  return getUser(user_id);
}

export async function createUserCar(user_id, car) {
  const [result, fields] = await pool.query(
    `INSERT INTO cars (user_id, model, seats, license, picture, color) VALUES (?, ?, ?, ?, ?, ?)`,
    [user_id, car.model, car.seats, car.license, car.picture, car.color]
  );
  return getUserCar(result.insertId);
}

export async function updateUserPicture(user_id, picture) {
  const [result] = await pool.query(
    `UPDATE users SET picture = ? WHERE (id = ?)`,
    [picture, user_id]
  );
  return getUser(user_id);
}

export async function updateUserRating(user_id, ratings_sum, ratings_count) {
  const [result] = await pool.query(
    `UPDATE users SET ratings_sum = ?, ratings_count = ? WHERE (id = ?)`,
    [ratings_sum, ratings_count, user_id]
  );
}

export async function updateUserCar(user_id, car) {
  const [result] = await pool.query(
    `UPDATE cars SET model = ?, seats = ?, license = ?, picture = ?, color = ? WHERE (user_id = ?) & (car_id = ?)`,
    [
      car.model,
      car.seats,
      car.license,
      car.picture,
      car.color,
      user_id,
      car.car_id,
    ]
  );
  return getUserCar(car.car_id);
}

export async function removeUserCar(user_id, car_id) {
  const [result, fields] = await pool.query(
    `DELETE FROM cars WHERE (user_id = ?) & (car_id = ?)`,
    [user_id, car_id]
  );
}

export async function removeUser(user_id) {
  const [result, fields] = await pool.query(`DELETE FROM users WHERE id = ?`, [
    user_id,
  ]);
}
