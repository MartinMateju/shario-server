import { checkoutFactory } from "../factories/checkoutFactory.js";

export class CheckoutBuilder {
  constructor() {
    this.tenant = checkoutFactory.tenantId();
    this.product = checkoutFactory.product({
      tenant: this.tenant,
      type: "public-workshop",
      price: 150,
    });
    this.user = checkoutFactory.user({ tenant: this.tenant });
    this.cartItems = [checkoutFactory.cartItem({ product: this.product })];
  }

  privateGrohova() {
    this.product.type = "private-workshop";
    this.product.extraCharge = 100;
    this.cartItems[0] = {
      ...this.cartItems[0],
      product: {
        _id: this.product._id,
        type: this.product.type,
      },
      location: "grohova",
      bookingType: "private",
      numberOfGuests: 1,
    };
    return this;
  }

  withCredits(amount) {
    this.user.moneyCredits = amount;
    return this;
  }

  withGuests(numberOfGuests) {
    this.cartItems[0].numberOfGuests = numberOfGuests;
    return this;
  }

  build() {
    return {
      tenant: this.tenant,
      user: this.user,
      product: this.product,
      cartItems: this.cartItems,
    };
  }
}
